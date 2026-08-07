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
  USER_PROFILE_LIST_FIELDS,
} from '../../lib/services'
import { Query, storage, appwriteConfig, ID } from '../../lib/appwrite'
import { storedDobToDateInputValue } from '../../lib/formUtils'
import { buildUserListView, ALL_TIERS } from '../../lib/userListView'

/**
 * How long the cached user set is served before the next interaction re-reads it.
 *
 * Bounds staleness: mutations made in this tab force a refresh explicitly, but a profile created by
 * another admin — or a new mobile signup — is only visible after a fresh read. Before this page
 * cached anything, every search refetched, so freshness was implicit; this keeps that property
 * within a minute while leaving a burst of typing entirely in memory.
 */
const USERS_CACHE_TTL_MS = 60_000

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
  const [tierFilter, setTierFilter] = useState(ALL_TIERS)
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
  const fetchIdRef = useRef(0)
  // The whole user set. Search / tier filter / sort / paging are resolved from this in memory, so
  // none of them costs a request. See loadAllUsers below for why.
  const allUsersRef = useRef<{ users: AppUser[]; at: number } | null>(null)
  const inFlightLoadRef = useRef<Promise<AppUser[]> | null>(null)
  /**
   * Tier metadata, mirrored into a ref so fetchUsers reads the latest values rather than whatever
   * its closure captured.
   *
   * Tiers load on their own request, in parallel with the user load and much faster than it. Reading
   * the state variable meant the first render usually resolved tiers as "not loaded yet" and showed
   * each user's STORED tier instead of the effective one, with no recompute afterwards because the
   * recompute effect is gated on isInitialLoad.
   */
  const tierDataRef = useRef<{ tiers: TierDocument[]; orderMap: Record<string, number> }>({
    tiers: [],
    orderMap: {},
  })

  /**
   * Load every user profile (plus its Auth email) once, then serve all interactions from memory.
   *
   * Search and the email/tier sorts have always been resolved client-side — email lives in Auth, not
   * user_profiles, and tier sorts by rank rather than alphabetically — so they already required the
   * FULL set, not a page of it. The page used to re-fetch that whole set on every debounced
   * keystroke, and re-resolve an Auth email for every profile each time. Measured against
   * production that was ~20s per search and up to ~77s while refining one.
   *
   * Loading once and filtering locally makes every one of those interactions instant, and removes
   * the class of bug where a match outside the fetched window was invisible. Concurrent callers
   * share one in-flight request so clearing a search can't start a second full load.
   */
  const loadAllUsers = async (force = false): Promise<AppUser[]> => {
    const cached = allUsersRef.current
    const isFresh = !!cached && Date.now() - cached.at < USERS_CACHE_TTL_MS
    if (!force && cached && isFresh) return cached.users
    if (!force && inFlightLoadRef.current) return inFlightLoadRef.current

    const load = appUsersService
      .listAllWithPagination([
        // Ship only the columns the list renders — the omitted `notifications` array is ~97% of a
        // profile's bytes. The Edit modal re-reads the full document separately.
        Query.select([...USER_PROFILE_LIST_FIELDS]),
        Query.orderDesc('$createdAt'),
      ])
      .then((result) => {
        allUsersRef.current = { users: result.users, at: Date.now() }
        return result.users
      })
      .catch((err) => {
        // Serve the stale set rather than emptying the table if a refresh fails.
        if (cached) return cached.users
        throw err
      })
      .finally(() => {
        inFlightLoadRef.current = null
      })

    inFlightLoadRef.current = load
    return load
  }

  // Resolve the list for the requested page. Only hits the network when the cache is cold, or when
  // a caller passes force=true after a mutation that changed a profile server-side.
  const fetchUsers = async (page: number = currentPage, force = false) => {
    const thisFetchId = ++fetchIdRef.current

    try {
      // Spin only when this actually waits on the network — showing the spinner for an in-memory
      // recompute makes the table flicker on every keystroke. Must mirror loadAllUsers' own
      // freshness test, otherwise an expired cache reloads with no loading state at all.
      const cached = allUsersRef.current
      const needsNetwork = force || !cached || Date.now() - cached.at >= USERS_CACHE_TTL_MS
      if (needsNetwork) {
        setIsLoading(true)
      }
      setError(null)

      const allUsers = await loadAllUsers(force)

      // A newer interaction superseded this one while the load was in flight.
      if (thisFetchId !== fetchIdRef.current) return

      const { tiers, orderMap } = tierDataRef.current
      const view = buildUserListView(allUsers, {
        searchQuery,
        tierFilter,
        sortBy,
        sortOrder,
        page,
        pageSize,
        tierOrderMap: orderMap,
        // Substitute the stored tierLevel with the effective tier (max of stored vs points-derived)
        // so the table shows the same tier the mobile app does on Achievements/Profile. Falls back
        // to the stored value until tier metadata has loaded.
        resolveTier:
          tiers.length > 0
            ? (user) => effectiveTierLevel(tiers, user.tierLevel, user.totalPoints ?? 0)
            : undefined,
      })

      // Reflect the effective tier on the rows the table renders, matching the resolver above.
      const rows =
        tiers.length > 0
          ? view.rows.map((user) => ({
              ...user,
              tierLevel: effectiveTierLevel(tiers, user.tierLevel, user.totalPoints ?? 0),
            }))
          : view.rows

      setTotalUsers(view.total)
      setTotalPages(view.totalPages)
      setUsers(rows)
      setCurrentPage(view.page)
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
      const nextTierOrderMap = tiers.reduce<Record<string, number>>((acc, tier, index) => {
        const tierName = String(tier.name ?? '').trim()
        if (tierName) {
          acc[tierName] = Number.isFinite(tier.order) ? Number(tier.order) : index
        }
        return acc
      }, {})
      // Ref first, so a user load still in flight resolves effective tiers correctly; the state
      // updates below drive the recompute for a list that has already rendered.
      tierDataRef.current = { tiers, orderMap: nextTierOrderMap }
      setFilterTierList(tiers)
      setTierOrderMap(nextTierOrderMap)
    } catch (err) {
      console.error('Error fetching tier order:', err)
      // Keep existing map; sorting will gracefully fall back for unknown tiers.
    }
  }

  // If tier names in Appwrite change, clear a filter value that no longer exists (avoids empty lists).
  useEffect(() => {
    if (tierFilter === ALL_TIERS || filterTierList.length === 0) return
    const valid = filterTierList.some((t) => String(t.name ?? '').trim() === tierFilter)
    if (!valid) {
      setTierFilter(ALL_TIERS)
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

  // Recompute the visible page whenever any view input changes, always landing back on page 1.
  //
  // One effect, not three: search, tier filter and sort were separate effects, so clearing the
  // search box — which also resets the tier filter and sort — fired several loads at once. Each of
  // those was a full-collection read plus an Auth email fan-out, which is why production showed
  // bursts of 54–163 Function executions for a single click. Now this is a pure in-memory
  // recompute, so it also needs no debounce: results update as you type.
  useEffect(() => {
    if (isInitialLoad) return
    fetchUsers(1)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, tierFilter, sortBy, sortOrder, tierOrderMap, filterTierList])

  // Handle search change; reset tier and sort to default when keyword is removed
  const handleSearchChange = (value: string) => {
    if (value.trim() === '') {
      setTierFilter(ALL_TIERS)
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
      // force: the new user is not in the cached set yet.
      await Promise.all([fetchUsers(1, true), fetchStatistics()])
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
        await Promise.all([fetchUsers(currentPage - 1, true), fetchStatistics()])
      } else {
        await Promise.all([fetchUsers(currentPage, true), fetchStatistics()])
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
      
      // Refresh list and statistics (force: isBlocked changed server-side)
      await fetchUsers(currentPage, true)
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
          hasFilters={tierFilter !== ALL_TIERS}
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

            // Refresh the users list (force: the edited profile changed server-side)
            await fetchUsers(currentPage, true)

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
        phoneVerified={
          typeof (userForEdit ?? selectedUser)?.phoneVerified === 'boolean'
            ? ((userForEdit ?? selectedUser)?.phoneVerified as boolean)
            : undefined
        }
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

