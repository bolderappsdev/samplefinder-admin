import { useState, useEffect, useCallback, useRef } from 'react'
import { DashboardLayout, ConfirmationModal } from '../../components'
import type { ConfirmationType } from '../../components'
import {
  NotificationsHeader,
  StatsCards,
  SearchAndFilter,
  NotificationsTable,
  CreateNotificationModal,
} from './components'
import {
  statisticsService,
  notificationsService,
  normalizeNotificationFormData,
  type NotificationsStats,
  type NotificationDocument,
  type NotificationFormData,
} from '../../lib/services'
import { useNotificationStore } from '../../stores/notificationStore'
import { useTimezoneStore } from '../../stores/timezoneStore'
import { utcToAppTimeFormInputs } from '../../lib/dateUtils'
import { Query } from '../../lib/appwrite'

interface Notification {
  id: string
  title: string
  target: string
  timing: string
  type: 'Notification' | 'Event Reminder' | 'Promotional' | 'Engagement'
  recipients: number
  date: string
  status: 'Scheduled' | 'Sent' | 'Draft'
}

const Notifications = () => {
  const { addNotification } = useNotificationStore()
  const { appTimezone } = useTimezoneStore()
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('All Types')
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'recipients' | 'target' | 'timing' | 'type' | 'status'>('date')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingNotification, setEditingNotification] = useState<{ id: string; data: NotificationFormData } | null>(null)
  const [duplicatingData, setDuplicatingData] = useState<NotificationFormData | null>(null)
  const [statistics, setStatistics] = useState<NotificationsStats | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalNotifications, setTotalNotifications] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [confirmationModal, setConfirmationModal] = useState<{
    isOpen: boolean
    type: ConfirmationType
    onConfirm: () => void
    itemName?: string
  }>({
    isOpen: false,
    type: 'delete',
    onConfirm: () => {},
  })

  const getAudienceDisplayLabel = (audience: NotificationDocument['targetAudience']): string => {
    switch (audience) {
      case 'All':
        return 'All'
      case 'NewUsers':
        return 'NewUsers'
      case 'BrandAmbassadors':
        return 'BrandAmbassadors'
      case 'Influencers':
        return 'Influencers'
      case 'Tier1':
        return 'Tier1'
      case 'Tier2':
        return 'Tier2'
      case 'Tier3':
        return 'Tier3'
      case 'Tier4':
        return 'Tier4'
      case 'Tier5':
        return 'Tier5'
      case 'ZipCode':
        return 'ZipCode'
      case 'Targeted':
        return 'Targeted'
      default:
        return String(audience)
    }
  }

  // Convert NotificationDocument to UI Notification format
  const convertNotification = (doc: NotificationDocument): Notification => {
    const date = doc.sentAt || doc.scheduledAt || doc.$createdAt
    const dateObj = new Date(date)
    const formatOpts = appTimezone
      ? { timeZone: appTimezone } as const
      : {}
    const timing = dateObj.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      ...formatOpts,
    })
    const formattedDate = dateObj.toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      ...formatOpts,
    })
    
    return {
      id: doc.$id,
      title: doc.title,
      target: getAudienceDisplayLabel(doc.targetAudience),
      timing,
      type: doc.type,
      recipients: doc.recipients || 0,
      date: formattedDate,
      status: doc.status,
    }
  }

  // Only the latest fetch may commit — search now pages the full set (multiple round-trips), so a
  // slower earlier fetch could otherwise resolve after a newer one and overwrite it.
  const fetchIdRef = useRef(0)

  // Fetch notifications with pagination
  const fetchNotifications = useCallback(async (page: number = currentPage) => {
    const thisFetchId = ++fetchIdRef.current
    try {
      setIsLoading(true)
      const baseQueries: string[] = []

      // Add type filter if not "All Types"
      if (typeFilter !== 'All Types') {
        baseQueries.push(Query.equal('type', [typeFilter]))
      }

      // Order by creation date (newest first)
      baseQueries.push(Query.orderDesc('$createdAt'))

      const trimmedSearch = searchQuery.trim()
      const isSearching = trimmedSearch.length > 0

      // Searching filters client-side (title/message), so it must scan the FULL set (searchAll pages
      // through everything, honoring the type filter) — not just the current page, which hid matches
      // on later pages. Browsing keeps efficient server-side pagination.
      const response = isSearching
        ? await notificationsService.searchAll(trimmedSearch, baseQueries)
        : await notificationsService.list([...baseQueries, Query.limit(pageSize), Query.offset((page - 1) * pageSize)])

      // Discard this result if a newer fetch has started (avoids stale overwrite).
      if (thisFetchId !== fetchIdRef.current) return

      // Extract pagination metadata
      const total = response.total
      const totalPagesCount = Math.ceil(total / pageSize)
      setTotalNotifications(total)
      setTotalPages(totalPagesCount)

      // Handle edge case: if current page exceeds total pages, reset to last valid page or page 1
      if (totalPagesCount > 0 && page > totalPagesCount) {
        const lastValidPage = totalPagesCount
        setCurrentPage(lastValidPage)
        if (page !== lastValidPage) {
          return fetchNotifications(lastValidPage)
        }
      } else if (totalPagesCount === 0) {
        setCurrentPage(1)
      }

      // Search returns the full matched set — paginate it client-side; browsing is already one page.
      const pageDocs = isSearching
        ? response.documents.slice((page - 1) * pageSize, page * pageSize)
        : response.documents
      const convertedNotifications = pageDocs.map(convertNotification)
      setNotifications(convertedNotifications)
      setCurrentPage(page)
    } catch (err) {
      console.error('Error fetching notifications:', err)
      addNotification({
        type: 'error',
        title: 'Error Loading Notifications',
        message: 'Failed to load notifications. Please refresh the page.',
      })
    } finally {
      if (thisFetchId === fetchIdRef.current) {
        setIsLoading(false)
      }
    }
  }, [typeFilter, searchQuery, addNotification, currentPage, pageSize])

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      fetchNotifications(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // Fetch statistics
  const fetchStatistics = useCallback(async () => {
    try {
      const stats = await statisticsService.getStatistics<NotificationsStats>('notifications')
      setStatistics(stats)
    } catch (err) {
      console.error('Error fetching statistics:', err)
      addNotification({
        type: 'error',
        title: 'Error Loading Statistics',
        message: 'Failed to load notifications statistics. Please refresh the page.',
      })
    }
  }, [addNotification])

  useEffect(() => {
    fetchStatistics()
  }, [fetchStatistics])

  // Reset to page 1 and refetch notifications when search or filter changes
  useEffect(() => {
    setCurrentPage(1)
    const timeoutId = setTimeout(() => {
      fetchNotifications(1)
    }, 300) // Debounce search

    return () => clearTimeout(timeoutId)
  }, [searchQuery, typeFilter, appTimezone]) // eslint-disable-line react-hooks/exhaustive-deps

  const stats = statistics
    ? [
        {
          label: 'Total Sent',
          value: statistics.totalSent.toLocaleString('en-US'),
          icon: 'mdi:file-document',
          iconBg: 'bg-green-100',
          iconColor: 'text-green-600',
        },
        {
          label: 'Avg. Open Rate',
          value: `${statistics.avgOpenRate}%`,
          icon: 'mdi:star-four-points',
          iconBg: 'bg-red-100',
          iconColor: 'text-red-600',
        },
        {
          label: 'Avg. Click Rate',
          value: `${statistics.avgClickRate}%`,
          icon: 'mdi:trending-up',
          iconBg: 'bg-orange-100',
          iconColor: 'text-orange-600',
        },
        {
          label: 'Scheduled',
          value: statistics.scheduled.toLocaleString('en-US'),
          icon: 'mdi:trending-up',
          iconBg: 'bg-blue-100',
          iconColor: 'text-blue-600',
        },
      ]
    : [
        {
          label: 'Total Sent',
          value: '0',
          icon: 'mdi:file-document',
          iconBg: 'bg-green-100',
          iconColor: 'text-green-600',
        },
        {
          label: 'Avg. Open Rate',
          value: '0%',
          icon: 'mdi:star-four-points',
          iconBg: 'bg-red-100',
          iconColor: 'text-red-600',
        },
        {
          label: 'Avg. Click Rate',
          value: '0%',
          icon: 'mdi:trending-up',
          iconBg: 'bg-orange-100',
          iconColor: 'text-orange-600',
        },
        {
          label: 'Scheduled',
          value: '0',
          icon: 'mdi:trending-up',
          iconBg: 'bg-blue-100',
          iconColor: 'text-blue-600',
        },
      ]

  // Handle save notification (create or update)
  const handleSaveNotification = async (notificationData: NotificationFormData) => {
    const refreshPage = editingNotification ? currentPage : 1
    try {
      if (editingNotification) {
        const result = await notificationsService.update(
          editingNotification.id,
          notificationData,
          appTimezone
        )

        if (result.sendFailed) {
          addNotification({
            type: 'warning',
            title: 'Notification saved; delivery failed',
            message:
              result.sendError ??
              'The notification was updated in the database but could not be sent. Try again or check server logs.',
          })
        } else {
          addNotification({
            type: 'success',
            title: 'Notification Updated',
            message:
              notificationData.schedule === 'Send Immediately'
                ? 'Notification has been sent successfully.'
                : 'Notification has been updated and scheduled for 1:00 PM EST.',
          })
        }

        setEditingNotification(null)
      } else {
        const result = await notificationsService.create(notificationData, appTimezone)

        if (result.sendFailed) {
          addNotification({
            type: 'warning',
            title: 'Notification created; delivery failed',
            message:
              result.sendError ??
              'The notification was saved but could not be sent. It may appear in the list as Draft; check logs or try sending again.',
          })
        } else {
          addNotification({
            type: 'success',
            title: 'Notification Created',
            message:
              notificationData.schedule === 'Send Immediately'
                ? 'Notification has been sent successfully.'
                : 'Notification has been scheduled for 1:00 PM EST.',
          })
        }

        setCurrentPage(1)
      }

      try {
        await Promise.all([fetchNotifications(refreshPage), fetchStatistics()])
      } catch (refreshError) {
        console.error('Error refreshing notifications after save:', refreshError)
        addNotification({
          type: 'warning',
          title: 'List may be out of date',
          message:
            'The notification was saved, but the list could not be refreshed. Reload the page to see the latest data.',
        })
      }

      setIsCreateModalOpen(false)
      setDuplicatingData(null)
    } catch (error: unknown) {
      console.error('Error saving notification:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to save notification. Please try again.'
      addNotification({
        type: 'error',
        title: editingNotification ? 'Error Updating Notification' : 'Error Creating Notification',
        message: errorMessage,
      })
      throw error instanceof Error ? error : new Error(errorMessage)
    }
  }

  // Handle edit notification - fetch full data and open modal
  const handleEditNotification = async (notification: Notification) => {
    try {
      // Fetch full notification document to get all fields including message
      const fullNotification = await notificationsService.getById(notification.id)
      
      // Parse scheduledAt to get date and time components
      let scheduledAt = ''
      let scheduledTime = ''
      let schedule: 'Send Immediately' | 'Schedule for Later' | 'Recurring' = 'Send Immediately'
      
      if (fullNotification.scheduledAt) {
        const { dateStr, timeStr } = utcToAppTimeFormInputs(
          fullNotification.scheduledAt,
          appTimezone
        )
        scheduledAt = dateStr
        scheduledTime = timeStr
        schedule = 'Schedule for Later'
      } else if (fullNotification.status === 'Sent') {
        schedule = 'Send Immediately'
      }

      const { targetAudience } = normalizeNotificationFormData(fullNotification)

      setEditingNotification({
        id: notification.id,
        data: {
          title: fullNotification.title,
          message: fullNotification.message,
          type: 'Notification',
          targetAudience,
          category: 'AppPush',
          schedule,
          scheduledAt,
          scheduledTime,
          selectedUserIds: fullNotification.selectedUserIds || [],
        }
      })
      setIsCreateModalOpen(true)
    } catch (error: unknown) {
      console.error('Error fetching notification:', error)
      addNotification({
        type: 'error',
        title: 'Error Loading Notification',
        message: 'Failed to load notification details. Please try again.',
      })
    }
  }

  // Handle duplicate notification - fetch data and open modal in create mode
  const handleDuplicateNotification = async (notification: Notification) => {
    try {
      // Fetch full notification document to get all fields including message
      const fullNotification = await notificationsService.getById(notification.id)
      const { targetAudience } = normalizeNotificationFormData(fullNotification)

      // Set duplicating data (not edit mode - will create a new notification)
      setDuplicatingData({
        title: fullNotification.title,
        message: fullNotification.message,
        type: 'Notification',
        targetAudience,
        category: 'AppPush',
        schedule: 'Send Immediately',
        scheduledAt: '',
        scheduledTime: '',
        selectedUserIds: fullNotification.selectedUserIds || [],
      })
      setIsCreateModalOpen(true)
    } catch (error: unknown) {
      console.error('Error fetching notification:', error)
      addNotification({
        type: 'error',
        title: 'Error Loading Notification',
        message: 'Failed to load notification details. Please try again.',
      })
    }
  }

  // Handle delete notification
  const handleDeleteNotification = async (notification: Notification) => {
    try {
      await notificationsService.delete(notification.id)
      
      // Close modal first
      setConfirmationModal(prev => ({ ...prev, isOpen: false }))
      
      addNotification({
        type: 'success',
        title: 'Notification Deleted',
        message: 'Notification has been deleted successfully.',
      })
      
      // Refresh notifications and statistics - check if we need to go back a page
      if (notifications.length === 1 && currentPage > 1) {
        setCurrentPage(currentPage - 1)
        await Promise.all([fetchNotifications(currentPage - 1), fetchStatistics()])
      } else {
        await Promise.all([fetchNotifications(currentPage), fetchStatistics()])
      }
    } catch (error: unknown) {
      console.error('Error deleting notification:', error)
      setConfirmationModal(prev => ({ ...prev, isOpen: false }))
      const errorMessage = error instanceof Error ? error.message : 'Failed to delete notification. Please try again.'
      addNotification({
        type: 'error',
        title: 'Error Deleting Notification',
        message: errorMessage,
      })
    }
  }

  const sortedNotifications = [...notifications].sort((a, b) => {
    const direction = sortOrder === 'asc' ? 1 : -1

    if (sortBy === 'date') {
      const parseDate = (dateStr: string): Date => {
        const [month, day, year] = dateStr.split('/')
        return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10))
      }
      const dateA = parseDate(a.date)
      const dateB = parseDate(b.date)
      return direction * (dateA.getTime() - dateB.getTime())
    }

    if (sortBy === 'name') {
      return (
        direction *
        a.title.localeCompare(b.title, undefined, {
          sensitivity: 'base',
        })
      )
    }

    if (sortBy === 'recipients') {
      return direction * (a.recipients - b.recipients)
    }

    if (sortBy === 'target') {
      return direction * (a.target.localeCompare(b.target, undefined, { sensitivity: 'base' }))
    }
    if (sortBy === 'timing') {
      return direction * (a.timing.localeCompare(b.timing, undefined, { sensitivity: 'base' }))
    }
    if (sortBy === 'type') {
      return direction * (a.type.localeCompare(b.type, undefined, { sensitivity: 'base' }))
    }
    if (sortBy === 'status') {
      return direction * (a.status.localeCompare(b.status, undefined, { sensitivity: 'base' }))
    }

    return 0
  })

  return (
    <DashboardLayout>
      <div className="p-8">
        <NotificationsHeader onCreateNotification={() => setIsCreateModalOpen(true)} />
        <StatsCards stats={stats} />
        <SearchAndFilter
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          sortBy={sortBy}
          onSortByChange={(value) => setSortBy(value as typeof sortBy)}
          sortOrder={sortOrder}
          onSortOrderChange={setSortOrder}
        />
        <NotificationsTable
          notifications={sortedNotifications}
          isLoading={isLoading}
          searchTerm={searchQuery}
          hasFilters={typeFilter !== 'All Types'}
          currentPage={currentPage}
          totalPages={totalPages}
          totalNotifications={totalNotifications}
          pageSize={pageSize}
          onPageChange={handlePageChange}
          onEditClick={(notification) => {
            handleEditNotification(notification)
          }}
          onDuplicateClick={(notification) => {
            handleDuplicateNotification(notification)
          }}
          onDeleteClick={(notification) => {
            setConfirmationModal({
              isOpen: true,
              type: 'delete',
              onConfirm: () => handleDeleteNotification(notification),
              itemName: `notification "${notification.title}"`,
            })
          }}
        />
      </div>

      {/* Create/Edit Notification Modal */}
      <CreateNotificationModal
        isOpen={isCreateModalOpen}
        onClose={() => {
          setIsCreateModalOpen(false)
          setEditingNotification(null)
          setDuplicatingData(null)
        }}
        onSave={handleSaveNotification}
        initialData={editingNotification?.data || duplicatingData}
        isEditMode={!!editingNotification}
        appTimezone={appTimezone}
      />

      {/* Confirmation Modal */}
      <ConfirmationModal
        isOpen={confirmationModal.isOpen}
        onClose={() => setConfirmationModal({ ...confirmationModal, isOpen: false })}
        onConfirm={confirmationModal.onConfirm}
        type={confirmationModal.type}
        itemName={confirmationModal.itemName}
      />
    </DashboardLayout>
  )
}

export default Notifications

