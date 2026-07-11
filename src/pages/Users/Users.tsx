import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  DashboardLayout,
  ShimmerPage,
  ConfirmationModal,
} from '../../components'
import { useNotificationStore } from '../../stores/notificationStore'
import {
  UsersHeader,
  SearchAndFilter,
  UsersTable,
  AddUserModal,
  EditUserModal,
  StatsCards,
} from './components'
import {
  appUsersService,
  triviaResponsesService,
  notificationsService,
  type AppUser,
  type UserFormData,
  statisticsService,
  type UsersStats,
  tiersService,
  type TierDocument,
  tierLevelForTotalPoints,
  effectiveTierLevel,
} from '../../lib/services'
import { Query, storage, appwriteConfig, ID } from '../../lib/appwrite'
import { storedDobToDateInputValue } from '../../lib/formUtils'

// Build a human-readable label for confirmation modals (e.g. "user
// John Smith", "user @jsmith", "user jsmith@example.com"). Returns
// 'user' as a fallback when no identifier is available.
const describeUser = (user: { firstName?: string; lastName?: string; username?: string; email?: string } | null | undefined): string => {
  if (!user) return 'user'
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  const label = fullName || user.username || user.email
  return label ? `user "${label}"` : 'user'
}

const Users = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const { addNotification } = useNotificationStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [tierFilter, setTierFilter] = useState('All Tiers')
  const [sortBy, setSortBy] = useState<'createdAt' | 'name' | 'points' | 'events' | 'reviews' | 'email' | 'tierLevel' | 'dob'>('createdAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [isAddUserModalOpen, setIsAddUserModalOpen] = useState(false)
  const [isEditUserModalOpen, setIsEditUserModalOpen] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isDeleteLoading, setIsDeleteLoading] = useState(false)
  const [blockModalState, setBlockModalState] = useState<{
    isOpen: boolean
    user: AppUser | null
    isLoading: boolean
  }>({ isOpen: false, user: null, isLoading: false })
  const [selectedUser, setSelectedUser] = useState<AppUser | null>(null)
  const [userForEdit, setUserForEdit] = useState<AppUser | null>(null)
  const [editModalTriviasWon, setEditModalTriviasWon] = useState<number | null>(null)
  const [userToDelete, setUserToDelete] = useState<AppUser | null>(null)
  const [users, setUsers] = useState<AppUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [statistics, setStatistics] = useState<UsersStats | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalUsers, setTotalUsers] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [tierOrderMap, setTierOrderMap] = useState<Record<string, number>>({})
  const [filterTierList, setFilterTierList] = useState<TierDocument[]>([])
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchIdRef = useRef(0)

  // Fetch users from Appwrite with pagination and search
  const fetchUsers = async (page: number = currentPage) => {
    const thisFetchId = ++fetchIdRef.current

    try {
      setIsLoading(true)
      setError(null)

      // Build queries
      const queries: string[] = []
      const trimmedSearch = searchQuery.trim()
      
      // Check if searching by email (contains @) or phone number (all digits)
      const isEmailSearch = trimmedSearch.length > 0 && trimmedSearch.includes('@')
      const digitsOnly = trimmedSearch.replace(/\D/g, '')
      const isPhoneSearch = trimmedSearch.length > 0 && digitsOnly && digitsOnly === trimmedSearch && digitsOnly.length >= 3
      
      // Note: email lives in the Auth system, not user_profiles, so ALL searches
      // (including partial-email input without '@') must fetch a larger set and
      // filter client-side to match against email as well as name/username.
      
      // Apply tier filter by canonical tierLevel field
      if (tierFilter !== 'All Tiers') {
        queries.push(Query.equal('tierLevel', [tierFilter]))
      }
      
      // Email sort requires client-side (email may come from Auth); fetch more then sort
      const isEmailSort = sortBy === 'email'
      const isTierSort = sortBy === 'tierLevel'
      if (!isEmailSort && !isTierSort) {
        const orderMethod = sortOrder === 'asc' ? Query.orderAsc : Query.orderDesc
        if (sortBy === 'points') {
          queries.push(orderMethod('totalPoints'))
        } else if (sortBy === 'name') {
          queries.push(orderMethod('firstname'))
        } else if (sortBy === 'events') {
          queries.push(orderMethod('totalEvents'))
        } else if (sortBy === 'reviews') {
          queries.push(orderMethod('totalReviews'))
        } else if (sortBy === 'dob') {
          queries.push(orderMethod('dob'))
        } else {
          queries.push(orderMethod('$createdAt'))
        }
      } else {
        // Email/Tier ordering is applied client-side after fetching (email lives in Auth; tier uses
        // rank order, not lexicographic). Still pin a stable server order so paging the full set
        // below returns consistent, non-overlapping pages.
        queries.push(Query.orderDesc('$createdAt'))
      }

      const hasSearch = trimmedSearch.length > 0
      // Search and email/tier sort are resolved client-side below, so they must see EVERY matching
      // record. A capped fetch here hid matches beyond the cap (e.g. a user older than the newest
      // 500) — which is why changing a filter/sort, and thus shifting the fetched window, surfaced
      // results a plain search had missed. Plain browsing keeps efficient server-side pagination.
      const needLargeFetch = isEmailSearch || isPhoneSearch || hasSearch || isEmailSort || isTierSort

      let result: { users: AppUser[]; total: number }
      if (needLargeFetch) {
        result = await appUsersService.listAllWithPagination(queries)
      } else {
        queries.push(Query.limit(pageSize))
        queries.push(Query.offset((page - 1) * pageSize))
        result = await appUsersService.listWithPagination(queries)
      }

      // Ignore result if a newer fetch has started (e.g. user cleared search before this completed)
      if (thisFetchId !== fetchIdRef.current) return

      // Substitute the stored tierLevel with the effective tier (max of stored vs
      // points-derived) so the table displays the same tier the mobile app shows on
      // Achievements/Profile. Falls back to stored value when tier metadata isn't loaded.
      const usersWithEffectiveTier = filterTierList.length > 0
        ? result.users.map((u) => ({
            ...u,
            tierLevel: effectiveTierLevel(filterTierList, u.tierLevel, u.totalPoints ?? 0),
          }))
        : result.users

      // Client-side filtering for accurate search results (email, phone, or text)
      let filteredUsers = usersWithEffectiveTier
      let filteredTotal = result.total

      if (isEmailSearch || isPhoneSearch) {
        filteredUsers = usersWithEffectiveTier.filter(user => {
          if (isEmailSearch) {
            return user.email?.toLowerCase().includes(trimmedSearch.toLowerCase())
          }
          if (isPhoneSearch) {
            const userPhoneDigits = (user.phoneNumber || '').replace(/\D/g, '')
            return userPhoneDigits.includes(digitsOnly)
          }
          return false
        })
        filteredTotal = filteredUsers.length

        const startIndex = (page - 1) * pageSize
        const endIndex = startIndex + pageSize
        filteredUsers = filteredUsers.slice(startIndex, endIndex)
      } else if (hasSearch) {
        // Text search: match against firstname, lastname, username, AND email (case-insensitive)
        const lowerSearch = trimmedSearch.toLowerCase()
        filteredUsers = usersWithEffectiveTier.filter(user =>
          [user.firstname, user.lastname, user.username, user.email].some(field =>
            field != null && String(field).toLowerCase().includes(lowerSearch)
          )
        )
        filteredTotal = filteredUsers.length

        const startIndex = (page - 1) * pageSize
        const endIndex = startIndex + pageSize
        filteredUsers = filteredUsers.slice(startIndex, endIndex)
      }

      // Email sort: client-side (email from Auth); sort then paginate
      if (isEmailSort) {
        const sorted = [...filteredUsers].sort((a, b) => {
          const ea = (a.email ?? '').toLowerCase()
          const eb = (b.email ?? '').toLowerCase()
          const cmp = ea.localeCompare(eb)
          return sortOrder === 'asc' ? cmp : -cmp
        })
        filteredTotal = sorted.length
        const startIndex = (page - 1) * pageSize
        filteredUsers = sorted.slice(startIndex, startIndex + pageSize)
      }

      // Tier sort: client-side by tier order rank (not lexicographic), then paginate
      if (isTierSort) {
        const getTierOrder = (tierLevel?: string) => {
          const tier = String(tierLevel ?? '').trim()
          if (!tier) return null
          return tierOrderMap[tier] ?? null
        }

        const sorted = [...filteredUsers].sort((a, b) => {
          const orderA = getTierOrder(a.tierLevel)
          const orderB = getTierOrder(b.tierLevel)

          // Keep unknown/empty tiers at the end regardless of direction
          if (orderA == null && orderB != null) return 1
          if (orderA != null && orderB == null) return -1
          if (orderA == null && orderB == null) return 0

          const cmp = (orderA as number) - (orderB as number)
          return sortOrder === 'asc' ? cmp : -cmp
        })

        filteredTotal = sorted.length
        const startIndex = (page - 1) * pageSize
        filteredUsers = sorted.slice(startIndex, startIndex + pageSize)
      }

      // Extract pagination metadata
      const totalPagesCount = Math.ceil(filteredTotal / pageSize)
      setTotalUsers(filteredTotal)
      setTotalPages(totalPagesCount)

      // Handle edge case: if current page exceeds total pages, reset to last valid page or page 1
      if (totalPagesCount > 0 && page > totalPagesCount) {
        const lastValidPage = totalPagesCount
        setCurrentPage(lastValidPage)
        if (page !== lastValidPage) {
          setIsLoading(false)
          return fetchUsers(lastValidPage)
        }
      } else if (totalPagesCount === 0) {
        setCurrentPage(1)
      }

      setUsers(filteredUsers)
      setCurrentPage(page)
    } catch (err) {
      if (thisFetchId !== fetchIdRef.current) return
      console.error('Error fetching users:', err)
      setError('Failed to load users. Please try again.')
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to load users. Please try again.',
      })
    } finally {
      if (thisFetchId === fetchIdRef.current) {
        setIsInitialLoad(false)
        setIsLoading(false)
      }
    }
  }

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      fetchUsers(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // Fetch statistics
  const fetchStatistics = async () => {
    try {
      const stats = await statisticsService.getStatistics<UsersStats>('users')
      setStatistics(stats)
    } catch (err) {
      console.error('Error fetching statistics:', err)
      addNotification({
        type: 'error',
        title: 'Error Loading Statistics',
        message: 'Failed to load users statistics. Please refresh the page.',
      })
    }
  }

  // Fetch tier metadata for rank-based tier sorting
  const fetchTierOrder = async () => {
    try {
      const tiers = await tiersService.list()
      setFilterTierList(tiers)
      const nextTierOrderMap = tiers.reduce<Record<string, number>>((acc, tier, index) => {
        const tierName = String(tier.name ?? '').trim()
        if (tierName) {
          acc[tierName] = Number.isFinite(tier.order) ? Number(tier.order) : index
        }
        return acc
      }, {})
      setTierOrderMap(nextTierOrderMap)
    } catch (err) {
      console.error('Error fetching tier order:', err)
      // Keep existing map; sorting will gracefully fall back for unknown tiers.
    }
  }

  // If tier names in Appwrite change, clear a filter value that no longer exists (avoids empty lists).
  useEffect(() => {
    if (tierFilter === 'All Tiers' || filterTierList.length === 0) return
    const valid = filterTierList.some((t) => String(t.name ?? '').trim() === tierFilter)
    if (!valid) {
      setTierFilter('All Tiers')
    }
  }, [filterTierList, tierFilter])

  // Initial load
  useEffect(() => {
    fetchUsers(1)
    fetchStatistics()
    fetchTierOrder()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Open user profile (Edit modal) when navigating with ?userId= (e.g. from Event Reviews)
  useEffect(() => {
    const userId = searchParams.get('userId')
    if (!userId) return
    let cancelled = false
    appUsersService
      .getById(userId)
      .then((user) => {
        if (cancelled || !user) return
        const appUser = user as AppUser
        setSelectedUser(appUser)
        setUserForEdit(appUser)
        setEditModalTriviasWon(null)
        setIsEditUserModalOpen(true)
        triviaResponsesService.getTriviasWonCountByUserId(userId).then((n) => {
          if (!cancelled) setEditModalTriviasWon(n)
        }).catch(() => { if (!cancelled) setEditModalTriviasWon(0) })
        setSearchParams((prev) => {
          prev.delete('userId')
          return prev
        }, { replace: true })
      })
      .catch(() => {
        if (!cancelled) {
          addNotification({
            type: 'error',
            title: 'User not found',
            message: 'The requested user profile could not be loaded.',
          })
          setSearchParams((prev) => {
            prev.delete('userId')
            return prev
          }, { replace: true })
        }
      })
    return () => { cancelled = true }
  }, [searchParams, setSearchParams, addNotification])

  // Refetch users when search query changes. When search is cleared, refetch immediately so the list resets; otherwise debounce.
  useEffect(() => {
    if (!isInitialLoad) {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }

      const trimmed = searchQuery.trim()
      if (trimmed === '') {
        // Search cleared: refetch immediately so the full list is shown right away
        fetchUsers(1)
      } else {
        // Typing: debounce to avoid a request on every keystroke
        searchTimeoutRef.current = setTimeout(() => {
          fetchUsers(1)
        }, 300)
      }

      return () => {
        if (searchTimeoutRef.current) {
          clearTimeout(searchTimeoutRef.current)
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  // Refetch users immediately when tier filter or sort changes (but not on initial load)
  useEffect(() => {
    if (!isInitialLoad) {
      fetchUsers(1)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierFilter, sortBy, sortOrder])

  // When tier ranks finish loading, refresh tier sort results once.
  useEffect(() => {
    if (!isInitialLoad && sortBy === 'tierLevel') {
      fetchUsers(1)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierOrderMap])

  // Handle search change; reset tier and sort to default when keyword is removed
  const handleSearchChange = (value: string) => {
    if (value.trim() === '') {
      setTierFilter('All Tiers')
      setSortBy('createdAt')
      setSortOrder('desc')
    }
    setSearchQuery(value)
    setCurrentPage(1) // Reset to page 1 when search changes
  }

  if (isInitialLoad) {
    return (
      <DashboardLayout>
        <ShimmerPage />
      </DashboardLayout>
    )
  }

  // Upload file to Appwrite Storage
  const uploadFile = async (file: File): Promise<string | null> => {
    try {
      if (!appwriteConfig.storage.bucketId) {
        throw new Error('Storage bucket ID is not configured')
      }

      const fileId = ID.unique()
      const result = await storage.createFile(
        appwriteConfig.storage.bucketId,
        fileId,
        file
      )

      // Get file preview URL
      const fileUrl = `${appwriteConfig.endpoint}/storage/buckets/${appwriteConfig.storage.bucketId}/files/${result.$id}/view?project=${appwriteConfig.projectId}`
      return fileUrl
    } catch (error) {
      console.error('Error uploading file:', error)
      throw error
    }
  }

  const handleCreateUser = async (userData: UserFormData) => {
    try {
      await appUsersService.create(userData)
      setCurrentPage(1)
      await Promise.all([fetchUsers(1), fetchStatistics()])
      setIsAddUserModalOpen(false)
      addNotification({
        type: 'success',
        title: 'User created successfully',
        message: 'A new user has been added to the system',
      })
    } catch (err) {
      console.error('Error creating user:', err)
      const errorMessage = err instanceof Error ? err.message : 'Failed to create user. Please try again.'
      addNotification({
        type: 'error',
        title: 'Error',
        message: errorMessage,
      })
    }
  }

  const handleDeleteUser = async () => {
    if (!userToDelete?.$id || !userToDelete?.authID) return

    try {
      setIsDeleteLoading(true)
      await appUsersService.delete(userToDelete.$id)
      // Check if we need to go back a page if current page becomes empty
      if (users.length === 1 && currentPage > 1) {
        setCurrentPage(currentPage - 1)
        await Promise.all([fetchUsers(currentPage - 1), fetchStatistics()])
      } else {
        await Promise.all([fetchUsers(currentPage), fetchStatistics()])
      }
      setIsDeleteModalOpen(false)
      setUserToDelete(null)
      setIsEditUserModalOpen(false)
      setSelectedUser(null)
      setUserForEdit(null)
      setEditModalTriviasWon(null)
      addNotification({
        type: 'success',
        title: 'User deleted successfully',
        message: 'User has been removed from the system',
      })
    } catch (err) {
      console.error('Error deleting user:', err)
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to delete user. Please try again.',
      })
    } finally {
      setIsDeleteLoading(false)
    }
  }

  const handleBlockUser = async () => {
    if (!blockModalState.user?.$id) return

    try {
      setBlockModalState(prev => ({ ...prev, isLoading: true }))
      const isCurrentlyBlocked = (blockModalState.user as { isBlocked?: boolean }).isBlocked || false
      
      if (isCurrentlyBlocked) {
        // Unblock user
        await appUsersService.unblockUser(blockModalState.user.$id)
        addNotification({
          type: 'success',
          title: 'User unblocked successfully',
          message: 'User can now login to the system',
        })
      } else {
        // Block user
        await appUsersService.blockUser(blockModalState.user.$id)
        addNotification({
          type: 'success',
          title: 'User blocked successfully',
          message: 'User has been added to blacklist and will be logged out',
        })
      }
      
      // Refresh list and statistics
      await fetchUsers(currentPage)
      await fetchStatistics()
      
      // Update selectedUser with new blocked status to refresh Edit Modal
      // Only update the isBlocked field to avoid re-rendering the entire form
      if (selectedUser && selectedUser.$id === blockModalState.user.$id) {
        setSelectedUser(prev => prev ? {
          ...prev,
          isBlocked: !isCurrentlyBlocked,
        } as AppUser : null)
      }
      
      // Close block modal
      
      // Keep Edit User Modal open
    } catch (err) {
      console.error('Error blocking/unblocking user:', err)
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to update user status. Please try again.',
      })
    } finally {
      setBlockModalState({ isOpen: false, user: null, isLoading: false })

    }
  }

  return (
    <DashboardLayout>
      <div className="p-8">
        <UsersHeader onAddUser={() => setIsAddUserModalOpen(true)} />
        {statistics && (
          <StatsCards
            stats={[
              {
                label: 'Total Users',
                value: statistics.totalUsers.toLocaleString('en-US'),
                icon: 'mdi:account-group',
                iconBg: 'bg-green-100',
                iconColor: 'text-green-600',
              },
              {
                label: 'Avg. Points',
                value: statistics.avgPoints.toLocaleString('en-US'),
                icon: 'mdi:star-four-points',
                iconBg: 'bg-red-100',
                iconColor: 'text-red-600',
              },
              {
                label: 'New This Week',
                value: statistics.newThisWeek.toLocaleString('en-US'),
                icon: 'mdi:trending-up',
                iconBg: 'bg-orange-100',
                iconColor: 'text-orange-600',
              },
              {
                label: 'Users in Blacklist',
                value: statistics.usersInBlacklist.toLocaleString('en-US'),
                icon: 'mdi:trending-up',
                iconBg: 'bg-gray-100',
                iconColor: 'text-gray-600',
              },
            ]}
          />
        )}
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-2 text-red-500 hover:text-red-700"
            >
              ×
            </button>
          </div>
        )}
        <SearchAndFilter
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          tierFilter={tierFilter}
          onTierFilterChange={setTierFilter}
          tiers={filterTierList}
          sortBy={sortBy}
          onSortByChange={(value) => setSortBy(value as typeof sortBy)}
          sortOrder={sortOrder}
          onSortOrderChange={setSortOrder}
        />
        <UsersTable
          users={users}
          isLoading={isLoading}
          searchTerm={searchQuery}
          hasFilters={tierFilter !== 'All Tiers'}
          currentPage={currentPage}
          totalPages={totalPages}
          totalUsers={totalUsers}
          pageSize={pageSize}
          onPageChange={handlePageChange}
          onEditClick={async (user) => {
            const appUser = user as AppUser
            setSelectedUser(appUser)
            setUserForEdit(null)
            setEditModalTriviasWon(null)
            setIsEditUserModalOpen(true)
            triviaResponsesService.getTriviasWonCountByUserId(appUser.$id).then(setEditModalTriviasWon).catch(() => setEditModalTriviasWon(0))
            try {
              const fresh = await appUsersService.getById(appUser.$id)
              if (fresh) setUserForEdit(fresh)
            } catch {
              setUserForEdit(appUser)
            }
          }}
          onDeleteClick={(user) => {
            setIsDeleteLoading(false)
            setUserToDelete(user as AppUser)
            setIsDeleteModalOpen(true)
          }}
        />
      </div>

      {/* Add User Modal */}
      <AddUserModal
        isOpen={isAddUserModalOpen}
        onClose={() => setIsAddUserModalOpen(false)}
        onSave={async (userData) => {
          let avatarURL: string | undefined = undefined
          if (userData.image instanceof File) {
            try {
              avatarURL = (await uploadFile(userData.image)) || undefined
            } catch (uploadError) {
              console.error('Error uploading profile picture:', uploadError)
              addNotification({
                type: 'error',
                title: 'Upload Failed',
                message: 'Failed to upload profile picture. The user will be created without one.',
              })
            }
          }
          await handleCreateUser({
            email: userData.email,
            password: userData.password,
            firstname: userData.firstName,
            lastname: userData.lastName,
            username: userData.username,
            phoneNumber: userData.phoneNumber,
            role: userData.role as 'admin' | 'user',
            tierLevel: userData.tierLevel,
            totalPoints: userData.totalPoints,
            dob: userData.dob,
            zipCode: userData.zipCode,
            avatarURL,
          })
        }}
      />

      {/* Edit User Modal */}
      <EditUserModal
        isOpen={isEditUserModalOpen}
        userId={selectedUser?.$id}
        onClose={() => {
          setIsEditUserModalOpen(false)
          setSelectedUser(null)
          setUserForEdit(null)
          setEditModalTriviasWon(null)
        }}
        onSave={async (userData) => {
          if (!selectedUser?.$id) return
          
          try {
            // Handle profile picture upload if a new file was selected
            let avatarURL: string | undefined = undefined
            if (userData.image && userData.image instanceof File) {
              try {
                avatarURL = await uploadFile(userData.image) || undefined
              } catch (uploadError) {
                console.error('Error uploading profile picture:', uploadError)
                addNotification({
                  type: 'error',
                  title: 'Upload Failed',
                  message: 'Failed to upload profile picture. Other changes will still be saved.',
                })
              }
            } else if (userData.image === null) {
              // User deleted the image
              avatarURL = undefined
            } else if (typeof userData.image === 'string') {
              // Existing image URL - don't change it
              avatarURL = userData.image
            }
            
            const totalPoints = Number(userData.userPoints) || 0
            const previousTier =
              (selectedUser.tierLevel != null && String(selectedUser.tierLevel).trim().length > 0)
                ? String(selectedUser.tierLevel)
                : null
            const previousTierString = previousTier ?? ''
            const resolvedTierLevel =
              filterTierList.length > 0
                ? tierLevelForTotalPoints(filterTierList, totalPoints)
                : previousTierString

            // Map the UI field names to actual database field names
            // Only include fields that exist in the database schema
            const updateData: Record<string, unknown> = {
              firstname: userData.firstName,
              lastname: userData.lastName,
              zipCode: userData.zipCode,
              phoneNumber: userData.phoneNumber,
              totalPoints,
              isAmbassador: userData.baBadge === 'Yes',
              username: userData.username,
              isInfluencer: userData.influencerBadge === 'Yes',
              referralCode: userData.referralCode,
              // Role is set at creation only and is intentionally NOT part of the edit payload.
              // Tier follows totalPoints when tier metadata is loaded; otherwise keep the stored value
              tierLevel: resolvedTierLevel || previousTierString,
              // Date of birth: send ISO string for datetime attribute (YYYY-MM-DD -> YYYY-MM-DDT00:00:00.000Z)
              ...(userData.dob?.trim()
                ? { dob: userData.dob.trim().length === 10 ? `${userData.dob.trim()}T00:00:00.000Z` : userData.dob.trim() }
                : {}),
            }
            
            // Add avatarURL only if it was changed
            if (avatarURL !== undefined) {
              updateData.avatarURL = avatarURL
            }
            
            // Detect badge changes before updating
            const wasAmbassador = selectedUser.isAmbassador ?? (selectedUser as { baBadge?: boolean }).baBadge ?? false
            const wasInfluencer = selectedUser.isInfluencer ?? (selectedUser as { influencerBadge?: boolean }).influencerBadge ?? false
            const nowAmbassador = updateData.isAmbassador as boolean
            const nowInfluencer = updateData.isInfluencer as boolean

            // Detect tier change for notifications (tier is derived from points when tier list is available)
            const updatedTierRaw =
              resolvedTierLevel.length > 0
                ? resolvedTierLevel
                : previousTierString
            const newTier = updatedTierRaw.length > 0 ? updatedTierRaw : null

            // Update user profile in database
            await appUsersService.update(selectedUser.$id, updateData)

            // Send badge notifications if badges were just granted (await and surface errors)
            const badgePromises: Promise<void>[] = []
            if (nowAmbassador && !wasAmbassador && selectedUser.authID) {
              badgePromises.push(
                notificationsService.sendBadgeNotification(selectedUser.authID, 'ambassador')
              )
            }
            if (nowInfluencer && !wasInfluencer && selectedUser.authID) {
              badgePromises.push(
                notificationsService.sendBadgeNotification(selectedUser.authID, 'influencer')
              )
            }
            if (badgePromises.length > 0) {
              const results = await Promise.allSettled(badgePromises)
              const failed = results.filter((r) => r.status === 'rejected')
              if (failed.length > 0) {
                const message =
                  failed.length === 1
                    ? (failed[0] as PromiseRejectedResult).reason?.message ?? 'Badge notification could not be sent.'
                    : 'One or more badge notifications could not be sent.'
                addNotification({
                  type: 'warning',
                  title: 'Badge notification failed',
                  message,
                })
              }
            }

            // Send tier notification if tier actually changed and we have the auth user ID
            if (selectedUser.authID && previousTier !== newTier && newTier) {
              try {
                await notificationsService.sendTierNotification(
                  selectedUser.authID,
                  previousTier,
                  newTier
                )
              } catch (tierError) {
                console.error('Error sending tier notification:', tierError)
                addNotification({
                  type: 'warning',
                  title: 'Tier notification failed',
                  message:
                    tierError instanceof Error
                      ? tierError.message
                      : 'Tier notification could not be sent.',
                })
              }
            }

            // Refresh the users list
            await fetchUsers(currentPage)
            
            setIsEditUserModalOpen(false)
            setSelectedUser(null)
            setUserForEdit(null)
            setEditModalTriviasWon(null)
            
            addNotification({
              type: 'success',
              title: 'User updated successfully',
              message: 'User information has been updated',
            })
          } catch (err) {
            console.error('Error updating user:', err)
            const extractedMessage =
              err instanceof Error
                ? err.message
                : typeof err === 'string'
                  ? err
                  : typeof (err as { message?: unknown })?.message === 'string'
                    ? (err as { message?: string }).message
                    : null

            const normalized = extractedMessage?.toLowerCase() ?? ''
            const isPhoneDuplicate =
              normalized.includes('phone number already exists') ||
              (normalized.includes('phone') && normalized.includes('already exists'))
            const isUsernameDuplicate =
              normalized.includes('username already exists') ||
              (normalized.includes('username') && normalized.includes('already exists'))
            const shouldUseBackendMessage = isPhoneDuplicate || isUsernameDuplicate

            addNotification({
              type: 'error',
              title: 'Error',
              message: shouldUseBackendMessage && extractedMessage ? extractedMessage : 'Failed to update user. Please try again.',
            })
            throw new Error(extractedMessage ?? 'Failed to update user. Please try again.')
          }
        }}
        onAddToBlacklist={() => {
          setBlockModalState({ isOpen: true, user: selectedUser, isLoading: false })
        }}
        isDeleteLoading={isDeleteLoading}
        onDelete={() => {
          setIsDeleteLoading(false)
          setUserToDelete(selectedUser)
          setIsDeleteModalOpen(true)
        }}
        initialData={(() => {
          const u = userForEdit ?? selectedUser
          if (!u) return undefined
          const profileTrivias =
            u.triviasWon != null && !Number.isNaN(Number(u.triviasWon))
              ? Number(u.triviasWon)
              : null
          const triviasWonDisplay = profileTrivias ?? editModalTriviasWon ?? 0
          return {
            image: u.avatarURL || null,
            firstName: String(u.firstname ?? u.firstName ?? ''),
            lastName: String(u.lastname ?? u.lastName ?? ''),
            zipCode: String(u.zipCode ?? ''),
            phoneNumber: String(u.phoneNumber ?? ''),
            userPoints: String(u.totalPoints ?? u.userPoints ?? '0'),
            baBadge: (u.isAmbassador ?? u.baBadge) ? 'Yes' : 'No',
            signUpDate: u.$createdAt ? new Date(u.$createdAt).toISOString().split('T')[0] : '',
            password: '**********',
            checkIns: String(u.totalEvents ?? u.checkIns ?? '0'),
            username: String(u.username ?? ''),
            email: u.email,
            tierLevel: String(u.tierLevel ?? ''),
            role: String(u.role ?? 'user'),
            checkInReviewPoints: String(u.checkInReviewPoints ?? '0'),
            influencerBadge: (u.isInfluencer ?? u.influencerBadge) ? 'Yes' : 'No',
            lastLogin: u.$updatedAt ? new Date(u.$updatedAt).toISOString().split('T')[0] : '',
            referralCode: String(u.referralCode ?? ''),
            reviews: String(u.totalReviews ?? u.reviews ?? '0'),
            triviasWon: String(triviasWonDisplay),
            isBlocked: (u as { isBlocked?: boolean }).isBlocked || false,
            dob: storedDobToDateInputValue(u.dob),
          }
        })()}
      />

      {/* Block/Unblock Confirmation Modal */}
      <ConfirmationModal
        isOpen={blockModalState.isOpen}
        onClose={() => {
          if (!blockModalState.isLoading) {
            setBlockModalState({ isOpen: false, user: null, isLoading: false })
          }
        }}
        onConfirm={handleBlockUser}
        type={(blockModalState.user as { isBlocked?: boolean })?.isBlocked ? 'unblock' : 'block'}
        itemName={describeUser(blockModalState.user)}
        isLoading={blockModalState.isLoading}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          if (!isDeleteLoading) {
            setIsDeleteModalOpen(false)
            setUserToDelete(null)
          }
        }}
        onConfirm={handleDeleteUser}
        type="delete"
        itemName={describeUser(userToDelete)}
        isLoading={isDeleteLoading}
      />
    </DashboardLayout>
  )
}

export default Users

