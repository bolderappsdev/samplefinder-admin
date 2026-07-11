import { useCallback, useEffect, useState, useRef } from 'react'
import { ConfirmationModal, DashboardLayout } from '../../components'
import { Query, storage, appwriteConfig, ID } from '../../lib/appwrite'
import { clientsService, statisticsService, type ClientDocument, type ClientsStats } from '../../lib/services'
import { fetchAllPages } from '../../lib/paginateAll'
import { useNotificationStore } from '../../stores/notificationStore'
import { useTimezoneStore } from '../../stores/timezoneStore'
import { formatDateInAppTimezone } from '../../lib/dateUtils'
import {
  AddClientModal,
  ClientsBrandsHeader,
  ClientsTable,
  EditClientModal,
  SearchAndFilter,
  SummaryCards,
} from './components'

// UI Client interface (for display and table)
interface UIClient {
  id?: string
  clientName: string
  totalEvents: number
  numberOfFavorites: number
  numberOfCheckIns: number
  totalPoints: number
  joinDate: string
  productTypes?: string[]
  logoUrl?: string
  description?: string
}

// Helper function to extract error message from Appwrite error
const extractErrorMessage = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const errorObj = error as Record<string, unknown>
    
    // Check for Appwrite error response format
    if ('response' in errorObj && errorObj.response && typeof errorObj.response === 'object') {
      const response = errorObj.response as Record<string, unknown>
      if ('message' in response && typeof response.message === 'string') {
        return response.message
      }
    }
    
    // Check for direct message property
    if ('message' in errorObj && typeof errorObj.message === 'string') {
      return errorObj.message
    }
  }
  
  // Fallback for Error instances
  if (error instanceof Error) {
    return error.message
  }
  
  return 'An unexpected error occurred'
}

const ClientsBrands = () => {
  const { addNotification } = useNotificationStore()
  const { appTimezone } = useTimezoneStore()
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [selectedClient, setSelectedClient] = useState<UIClient | null>(null)
  const [clientToDelete, setClientToDelete] = useState<UIClient | null>(null)
  const isDeletingRef = useRef(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Transform ClientDocument to UIClient for display
  const transformToUIClient = (
    doc: ClientDocument,
    stats?: { totalEvents: number; totalFavorites: number; totalCheckIns: number; totalPoints: number }
  ): UIClient => {
    return {
      id: doc.$id,
      clientName: doc.name,
      // Use computed stats from related collections
      totalEvents: stats?.totalEvents ?? 0,
      numberOfFavorites: stats?.totalFavorites ?? 0,
      numberOfCheckIns: stats?.totalCheckIns ?? 0,
      totalPoints: stats?.totalPoints ?? 0,
      joinDate: doc.$createdAt ? formatDateInAppTimezone(doc.$createdAt, appTimezone, 'short') : '',
      productTypes: doc.productType || [],
      logoUrl: doc.logoURL,
      description: (doc as Record<string, unknown>).description as string | undefined,
    }
  }

  const [clients, setClients] = useState<UIClient[]>([])
  const [statistics, setStatistics] = useState<ClientsStats | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalClients, setTotalClients] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortBy, setSortBy] = useState<string>('$createdAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  // Only the latest fetch may commit — the stats-sort path now pages the full set + computes stats
  // (multiple round-trips), so a slower earlier fetch could otherwise resolve after a newer one.
  const fetchIdRef = useRef(0)

  // Fetch clients from Appwrite with pagination, search, and sorting
  const fetchClients = async (page: number = currentPage) => {
    const thisFetchId = ++fetchIdRef.current
    try {
      setIsLoading(true)
      setError(null)
      
      // Base queries: search filter (Query.contains is server-side, no fulltext index needed) + order.
      // No limit/offset here — added per-branch below.
      const baseQueries: string[] = []
      if (searchTerm.trim()) {
        baseQueries.push(Query.contains('name', searchTerm.trim()))
      }

      // Stats-based sort (totalEvents, numberOfFavorites, etc.) is computed client-side
      const isStatsSort =
        sortBy === 'totalEvents' ||
        sortBy === 'numberOfFavorites' ||
        sortBy === 'numberOfCheckIns' ||
        sortBy === 'totalPoints'

      if (!isStatsSort) {
        const orderMethod = sortOrder === 'asc' ? Query.orderAsc : Query.orderDesc
        baseQueries.push(sortBy === 'name' ? orderMethod('name') : orderMethod('$createdAt'))
      } else {
        baseQueries.push(Query.orderDesc('$createdAt')) // stable order for the full fetch
      }

      let result: { documents: ClientDocument[]; total: number }
      if (isStatsSort) {
        // Stats sorts rank on client-computed values, so they must cover the FULL set — a capped
        // 500-row fetch dropped clients beyond it (and let an unrelated change "reveal" more).
        // getClientsStats already scans events/reviews/users collection-wide, so covering every
        // client adds little cost.
        const allClients = await fetchAllPages<ClientDocument>((cursor, limit) =>
          clientsService.list([
            ...baseQueries,
            Query.limit(limit),
            ...(cursor ? [Query.cursorAfter(cursor)] : []),
          ])
        )
        result = { documents: allClients, total: allClients.length }
      } else {
        result = await clientsService.list([
          ...baseQueries,
          Query.limit(pageSize),
          Query.offset((page - 1) * pageSize),
        ])
      }

      const clientIds = result.documents.map(doc => doc.$id)
      const statsMap = await clientsService.getClientsStats(clientIds)

      // Discard this result if a newer fetch has started (avoids stale overwrite). Everything below
      // is synchronous, so one check here covers both the stats-sort and plain branches.
      if (thisFetchId !== fetchIdRef.current) return

      let transformedClients = result.documents.map(doc => {
        const stats = statsMap.get(doc.$id)
        return transformToUIClient(doc, stats)
      })

      if (isStatsSort) {
        const dir = sortOrder === 'asc' ? 1 : -1
        transformedClients = [...transformedClients].sort((a, b) => {
          const aVal = a[sortBy as keyof UIClient] as number
          const bVal = b[sortBy as keyof UIClient] as number
          return dir * (Number(aVal) - Number(bVal))
        })
        const total = transformedClients.length
        const totalPagesCount = Math.ceil(total / pageSize)
        setTotalClients(total)
        setTotalPages(totalPagesCount)
        if (totalPagesCount > 0 && page > totalPagesCount) {
          const lastValidPage = totalPagesCount
          setCurrentPage(lastValidPage)
          return fetchClients(lastValidPage)
        }
        if (totalPagesCount === 0) setCurrentPage(1)
        transformedClients = transformedClients.slice((page - 1) * pageSize, page * pageSize)
      } else {
        const total = result.total
        const totalPagesCount = Math.ceil(total / pageSize)
        setTotalClients(total)
        setTotalPages(totalPagesCount)
        if (totalPagesCount > 0 && page > totalPagesCount) {
          const lastValidPage = totalPagesCount
          setCurrentPage(lastValidPage)
          if (page !== lastValidPage) return fetchClients(lastValidPage)
        } else if (totalPagesCount === 0) setCurrentPage(1)
      }

      setClients(transformedClients)
      setCurrentPage(page)
    } catch (err) {
      console.error('Error fetching clients:', err)
      setError('Failed to load clients. Please try again.')
    } finally {
      if (thisFetchId === fetchIdRef.current) {
        setIsLoading(false)
      }
    }
  }

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      fetchClients(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // Handle search change — useCallback keeps a stable reference so SearchAndFilter's
  // debounce useEffect doesn't re-fire on every parent re-render
  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value)
    setCurrentPage(1)
  }, [])

  // Handle sort by change
  const handleSortByChange = useCallback((value: string) => {
    setSortBy(value)
    setCurrentPage(1)
  }, [])

  // Handle sort order change
  const handleSortOrderChange = useCallback((order: 'asc' | 'desc') => {
    setSortOrder(order)
    setCurrentPage(1)
  }, [])

  // Fetch statistics
  const fetchStatistics = async () => {
    try {
      const stats = await statisticsService.getStatistics<ClientsStats>('clients')
      setStatistics(stats)
    } catch (err) {
      console.error('Error fetching statistics:', err)
      addNotification({
        type: 'error',
        title: 'Error Loading Statistics',
        message: 'Failed to load clients statistics. Please refresh the page.',
      })
    }
  }

  useEffect(() => {
    fetchClients(1)
    fetchStatistics()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch clients when search, sort, or sort order changes
  useEffect(() => {
    fetchClients(1)
  }, [searchTerm, sortBy, sortOrder]) // eslint-disable-line react-hooks/exhaustive-deps

  // Map statistics to summary cards format
  const summaryCards = statistics
    ? [
        {
          label: 'Total Clients',
          value: statistics.totalClients.toLocaleString('en-US'),
          icon: 'mdi:format-list-bulleted',
          iconBg: 'bg-green-100',
          iconColor: 'text-green-600',
        },
        {
          label: 'New This Month',
          value: statistics.newThisMonth.toLocaleString('en-US'),
          icon: 'mdi:chart-line',
          iconBg: 'bg-orange-100',
          iconColor: 'text-orange-600',
        },
      ]
    : [
        {
          label: 'Total Clients',
          value: '0',
          icon: 'mdi:format-list-bulleted',
          iconBg: 'bg-green-100',
          iconColor: 'text-green-600',
        },
        {
          label: 'New This Month',
          value: '0',
          icon: 'mdi:chart-line',
          iconBg: 'bg-orange-100',
          iconColor: 'text-orange-600',
        },
      ]

  const handleEditClick = (client: UIClient) => {
    setSelectedClient(client)
    setIsEditModalOpen(true)
  }

  const handleDeleteClick = (client: UIClient) => {
    // Prevent opening modal if delete is in progress
    if (isDeletingRef.current) return
    setClientToDelete(client)
    setIsDeleteModalOpen(true)
  }

  const handleConfirmDelete = async () => {
    if (clientToDelete?.id && !isDeletingRef.current) {
      const clientId = clientToDelete.id
      isDeletingRef.current = true
      
      // Close modal and clear state first
      setIsDeleteModalOpen(false)
      setClientToDelete(null)
      
      try {
        await clientsService.delete(clientId)
        // Check if we need to go back a page if current page becomes empty
        if (clients.length === 1 && currentPage > 1) {
          setCurrentPage(currentPage - 1)
          await Promise.all([fetchClients(currentPage - 1), fetchStatistics()])
        } else {
          await Promise.all([fetchClients(currentPage), fetchStatistics()])
        }

        // Show success notification
        addNotification({
          type: 'success',
          title: 'Client Deleted',
          message: 'The client has been successfully deleted.',
        })
      } catch (err) {
        console.error('Error deleting client:', err)
        addNotification({
          type: 'error',
          title: 'Failed to Delete Client',
          message: extractErrorMessage(err),
        })
      } finally {
        isDeletingRef.current = false
      }
    }
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

  const handleCreateClient = async (clientData: {
    logo: File | null
    clientName: string
    productTypes: string[]
    description: string
  }) => {
    try {
      // Upload logo if provided
      let logoURL: string | undefined = undefined
      if (clientData.logo && clientData.logo instanceof File) {
        logoURL = await uploadFile(clientData.logo) || undefined
      }

      // Transform data to match ClientFormData interface
      const formData: {
        name: string
        productType: string[]
        logoURL?: string
        description?: string
      } = {
        name: clientData.clientName,
        productType: clientData.productTypes,
        logoURL,
        description: clientData.description || undefined,
      }
      
      await clientsService.create(formData)
      setCurrentPage(1)
      await Promise.all([fetchClients(1), fetchStatistics()])

      // Show success notification
      addNotification({
        type: 'success',
        title: 'Client Created',
        message: 'The client has been successfully created.',
      })
      
      setIsModalOpen(false)
    } catch (err) {
      console.error('Error creating client:', err)
      
      // Extract error message from Appwrite error
      const errorMessage = extractErrorMessage(err)
      
      // Show error notification with actual error message
      addNotification({
        type: 'error',
        title: 'Failed to Create Client',
        message: errorMessage,
      })
      
      // Re-throw error so modal can handle it (keep modal open)
      throw err
    }
  }

  const handleUpdateClient = async (clientData: {
    logo: File | null
    clientName: string
    productTypes: string[]
    description: string
  }) => {
    if (!selectedClient?.id) return

    try {
      // Upload logo if a new one is provided
      let logoURL: string | undefined = undefined
      if (clientData.logo && clientData.logo instanceof File) {
        logoURL = await uploadFile(clientData.logo) || undefined
      }

      // Transform data to match ClientFormData interface
      const formData: Partial<{
        name: string
        productType: string[]
        logoURL?: string
        description?: string
      }> = {
        name: clientData.clientName,
        productType: clientData.productTypes,
        description: clientData.description || undefined,
      }

      // Only include logoURL if a new logo was uploaded
      if (logoURL) {
        formData.logoURL = logoURL
      }
      
      await clientsService.update(selectedClient.id, formData)
      await fetchClients(currentPage) // Refresh list - keep current page
      
      // Show success notification
      addNotification({
        type: 'success',
        title: 'Client Updated',
        message: 'The client has been successfully updated.',
      })
      
      setIsEditModalOpen(false)
      setSelectedClient(null)
    } catch (err) {
      console.error('Error updating client:', err)
      addNotification({
        type: 'error',
        title: 'Failed to Update Client',
        message: extractErrorMessage(err),
      })
    }
  }

  return (
    <DashboardLayout>
      <div className="p-8">
        <ClientsBrandsHeader onAddClient={() => setIsModalOpen(true)} />
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
        <SummaryCards cards={summaryCards} />
        <SearchAndFilter
          searchTerm={searchTerm}
          onSearchChange={handleSearchChange}
          sortBy={sortBy}
          onSortByChange={handleSortByChange}
          sortOrder={sortOrder}
          onSortOrderChange={handleSortOrderChange}
        />
        <ClientsTable
          clients={clients}
          isLoading={isLoading}
          searchTerm={searchTerm}
          currentPage={currentPage}
          totalPages={totalPages}
          totalClients={totalClients}
          pageSize={pageSize}
          onPageChange={handlePageChange}
          onEditClick={handleEditClick}
          onDeleteClick={handleDeleteClick}
        />
      </div>

      {/* Add Client Modal */}
      <AddClientModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleCreateClient}
      />

      {/* Edit Client Modal */}
      <EditClientModal
        key={selectedClient?.id || 'no-selected-client'}
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false)
          setSelectedClient(null)
        }}
        onSave={handleUpdateClient}
        initialData={
          selectedClient
            ? {
                clientName: selectedClient.clientName,
                productTypes: selectedClient.productTypes || [],
                logoUrl: selectedClient.logoUrl,
                description: selectedClient.description,
              }
            : undefined
        }
      />

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false)
          setClientToDelete(null)
        }}
        onConfirm={handleConfirmDelete}
        type="delete"
        itemName={clientToDelete?.clientName ? `"${clientToDelete.clientName}"` : 'client'}
      />
    </DashboardLayout>
  )
}

export default ClientsBrands

