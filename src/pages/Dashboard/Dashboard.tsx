import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Models } from 'appwrite'
import { DashboardLayout, ShimmerPage, ConfirmationModal } from '../../components'
import type { ConfirmationType } from '../../components'
import { eventsService, categoriesService, clientsService, locationsService, statisticsService, type DashboardStats, type ClientDocument } from '../../lib/services'
import { storage, appwriteConfig, ID } from '../../lib/appwrite'
import { useNotificationStore } from '../../stores/notificationStore'
import { useTimezoneStore } from '../../stores/timezoneStore'
import {
  appTimeToUTC,
  formatDateInAppTimezone,
  formatTimeInAppTimezone,
  getTimezoneAbbrevForDisplay,
  resolveSupportedAppTimezone,
  utcToAppTimeFormInputs,
} from '../../lib/dateUtils'
import { getEventStatus, getEventStatusColor, generateUniqueCheckInCode } from '../../lib/eventUtils'
import type { EventDocument } from '../../lib/services'
import { Query } from '../../lib/appwrite'
import {
  MetricsCards,
  SearchAndFilter,
  EventsTable,
  DashboardHeader,
  AddEventModal,
  EditEventModal,
  DateFilterModal,
  CSVUploadModal,
} from './components'

// Event interface for EventsTable (UI format)
interface Event {
  date: string
  venueName: string
  locationName: string
  brand: string
  startTime: string
  endTime: string
  timezone: string
  discount: string
  status: string
  statusColor: string
  id?: string // Add optional id for database reference
}

// Use EventDocument from services instead of creating a duplicate
type LocalEventDocument = EventDocument

const Dashboard = () => {
  const navigate = useNavigate()
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null)
  const [selectedEventDoc, setSelectedEventDoc] = useState<EventDocument | null>(null)
  const [addModalInitialData, setAddModalInitialData] = useState<{
    eventName?: string
    eventDate?: string
    startTime?: string
    endTime?: string
    city?: string
    address?: string
    state?: string
    zipCode?: string
    category?: string
    products?: string[]
    discount?: string
    discountImage?: File | string | null
    checkInCode?: string
    brandName?: string
    checkInPoints?: string
    reviewPoints?: string
    eventInfo?: string
    latitude?: string
    longitude?: string
    locationName?: string
    locationId?: string
    timezone?: string
  } | undefined>(undefined)
  const [editModalInitialData, setEditModalInitialData] = useState<{
    eventName?: string
    eventDate?: string
    startTime?: string
    endTime?: string
    city?: string
    address?: string
    state?: string
    zipCode?: string
    category?: string
    products?: string[]
    discount?: string
    discountImage?: File | string | null
    checkInCode?: string
    brandName?: string
    checkInPoints?: string
    reviewPoints?: string
    eventInfo?: string
    latitude?: string
    longitude?: string
    locationName?: string
    locationId?: string
    timezone?: string
  } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [isDateFilterOpen, setIsDateFilterOpen] = useState(false)
  const [isCSVUploadOpen, setIsCSVUploadOpen] = useState(false)
  const [events, setEvents] = useState<Event[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalEvents, setTotalEvents] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [categories, setCategories] = useState<Array<Models.Document & { title: string }>>([])
  const [brands, setBrands] = useState<Array<Models.Document & { name: string }>>([])
  const [dateRange, setDateRange] = useState<{ start: Date | null; end: Date | null }>({
    start: null,
    end: null,
  })
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all') // 'all', 'active', 'in_active', 'hidden', 'archived'
  const [sortBy, setSortBy] = useState<string>('date-asc') // 'date-*', 'name-*', 'brand-*', 'location-*'
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
  
  const { addNotification } = useNotificationStore()
  const { appTimezone } = useTimezoneStore()
  const [statistics, setStatistics] = useState<DashboardStats | null>(null)

  // Helper functions for formatting
  const formatNumber = (num: number): string => {
    return num.toLocaleString('en-US')
  }

  const formatPercentage = (change?: number): string => {
    if (change === undefined || change === null) return '+0%'
    const sign = change >= 0 ? '+' : ''
    return `${sign}${change}%`
  }

  // Convert known share links (e.g. Google Drive) into embeddable image URLs
  // so previews work in admin and consumer clients.
  /**
   * When an event is linked to a Location (`locationId`), address and map coordinates must come
   * from that Location document so colocated stores do not share identical denormalized lat/long by mistake.
   */
  const applyResolvedLocationToEventPayload = async (
    eventPayload: Record<string, unknown>,
    resolvedLocationId: string
  ): Promise<void> => {
    if (!appwriteConfig.eventsHasLocationIdAttribute) return
    try {
      const loc = await locationsService.getById(resolvedLocationId)
      if (!loc) return
      eventPayload.locationId = loc.$id
      eventPayload.locationName = loc.name ?? null
      if (loc.location && Array.isArray(loc.location) && loc.location.length >= 2) {
        eventPayload.location = loc.location
      }
      eventPayload.address = loc.address ?? ''
      eventPayload.city = loc.city ?? ''
      eventPayload.state = loc.state ?? ''
      eventPayload.zipCode = loc.zipCode ?? ''
    } catch (e) {
      console.error('applyResolvedLocationToEventPayload:', e)
    }
  }

  const normalizeDiscountImageUrl = (value?: string | null): string => {
    const trimmed = value?.trim()
    if (!trimmed) return ''

    console.log(value)

    try {
      const parsed = new URL(trimmed)
      const hostname = parsed.hostname.toLowerCase()

      if (hostname === 'drive.google.com' || hostname === 'docs.google.com') {
        let fileId = ''

        const pathMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/)
        if (pathMatch?.[1]) {
          fileId = pathMatch[1]
        } else {
          fileId = parsed.searchParams.get('id') || ''
        }

        if (fileId) {
          // `thumbnail` is generally more reliable for <img> rendering than `/file/.../view`.
          return `https://drive.google.com/thumbnail?id=${fileId}&sz=w2000`
        }
      }
    } catch {
      // Keep original value when URL parsing fails.
    }

    return trimmed
  }

  // Helper function to map database event document to EventsTable format (dates in app timezone)
  const mapEventDocumentToEvent = (doc: LocalEventDocument): Event => {
    const eventTimezone = doc.timezone || appTimezone
    const formatDate = (dateStr?: string): string =>
      dateStr ? formatDateInAppTimezone(dateStr, eventTimezone, 'short') : ''
    const formatTime = (timeStr?: string): string =>
      timeStr ? formatTimeInAppTimezone(timeStr, eventTimezone) : ''

    // Derive status from isArchived, isHidden, and event date/time (Active = live, Inactive = scheduled or completed)
    const status = getEventStatus(doc)

    // Show YES if event has any discount text or discount image
    const hasDiscount =
      (doc.discount != null && String(doc.discount).trim() !== '') ||
      (doc.discountImageURL != null && String(doc.discountImageURL).trim() !== '')

    
    return {
      id: doc.$id,
      date: formatDate(doc.startTime || doc.date),
      venueName: doc.name || '',
      locationName: doc.locationName || '',
      brand: '', // Will be populated from client relationship if needed
      startTime: formatTime(doc.startTime),
      endTime: formatTime(doc.endTime),
      timezone: getTimezoneAbbrevForDisplay(eventTimezone, doc.startTime || doc.date),
      discount: hasDiscount ? 'YES' : 'NO',
      status: status,
      statusColor: getEventStatusColor(status),
    }
  }

  // Fetch events from database with pagination, search, filter, and sort
  const fetchEvents = async (page: number = currentPage) => {
    try {
      setIsLoading(true)
      
      // Build base queries
      const queries: string[] = []
      
      // Apply status filter (for active/in_active we fetch non-archived, non-hidden then filter by derived status client-side)
      if (statusFilter === 'active' || statusFilter === 'in_active') {
        queries.push(Query.equal('isArchived', false))
        queries.push(Query.equal('isHidden', false))
      } else if (statusFilter === 'hidden') {
        queries.push(Query.equal('isHidden', true))
        queries.push(Query.equal('isArchived', false))
      } else if (statusFilter === 'archived') {
        queries.push(Query.equal('isArchived', true))
      }
      // 'all' status doesn't need any filter
      
      // Apply date range filter
      if (dateRange.start) {
        // If only start date is set (single date selection), treat it as both start and end of the same day
        if (!dateRange.end) {
          // Single date: filter for events on that specific day
          const startOfDay = new Date(dateRange.start)
          startOfDay.setHours(0, 0, 0, 0)
          const endOfDay = new Date(dateRange.start)
          endOfDay.setHours(23, 59, 59, 999)
          queries.push(Query.greaterThanEqual('date', startOfDay.toISOString()))
          queries.push(Query.lessThanEqual('date', endOfDay.toISOString()))
        } else {
          // Date range: use start and end dates
          queries.push(Query.greaterThanEqual('date', dateRange.start.toISOString()))
          // Set end date to end of day
          const endDate = new Date(dateRange.end)
          endDate.setHours(23, 59, 59, 999)
          queries.push(Query.lessThanEqual('date', endDate.toISOString()))
        }
      }
      
      // Apply sorting - parse sortBy value (format: "field-order")
      const [sortField, sortOrder] = sortBy.split('-')
      const orderMethod = sortOrder === 'asc' ? Query.orderAsc : Query.orderDesc
      if (sortField === 'date') {
        // Use startTime for chronological ordering; sorting by date (midnight UTC) can
        // produce inaccurate results across mixed event timezones.
        queries.push(orderMethod('startTime'))
      } else if (sortField === 'name') {
        queries.push(orderMethod('name'))
      } else if (sortField === 'brand') {
        // For brand sorting, we'll sort by date first, then handle brand sorting client-side
        // since brand is a relationship field
        queries.push(orderMethod('startTime'))
      } else if (sortField === 'location') {
        queries.push(orderMethod('locationName'))
      }
      
      // Determine if we're searching or filtering by derived status (Active / Inactive)
      const isSearching = searchTerm.trim().length > 0
      const needsClientSideStatusFilter = statusFilter === 'active' || statusFilter === 'in_active'
      
      // When searching or filtering by Active/Inactive, fetch more records for client-side filtering, then paginate
      if (!isSearching && !needsClientSideStatusFilter) {
        queries.push(Query.limit(pageSize))
        queries.push(Query.offset((page - 1) * pageSize))
      } else {
        // Fetch up to 500 records for client-side filtering
        queries.push(Query.limit(500))
      }
      
      // Fetch events with filters
      // When searching: use list() then filter by search term (including brand name) after resolving clients
      // When not searching: use list() with server-side pagination
      const result = await eventsService.list(queries)

      // Auto-transition expired hidden events to inactive by clearing hidden flag in DB.
      const now = new Date()
      const hiddenExpiredEvents = result.documents.filter((doc) => {
        if (!doc.isHidden) return false
        const eventEnd = doc.endTime ? new Date(doc.endTime) : null
        return !!eventEnd && !isNaN(eventEnd.getTime()) && now > eventEnd
      })
      if (hiddenExpiredEvents.length > 0) {
        await Promise.all(
          hiddenExpiredEvents.map((doc) => eventsService.update(doc.$id, { isHidden: false }))
        )
        hiddenExpiredEvents.forEach((doc) => {
          doc.isHidden = false
        })
      }

      // Collect client IDs from all fetched documents (needed for both search and non-search to resolve brand names)
      const clientIds = [...new Set(
        result.documents
          .map(doc => doc.client as string | undefined)
          .filter((id): id is string => !!id)
      )]
      const clientsMap = clientIds.length > 0
        ? await clientsService.getByIds(clientIds)
        : new Map<string, ClientDocument>()

      // Map all documents to events with brand names resolved
      let mappedEvents = result.documents.map((doc) => {
        const event = mapEventDocumentToEvent(doc as unknown as LocalEventDocument)
        if (doc.client) {
          const client = clientsMap.get(doc.client as string)
          event.brand = client?.name || ''
        }
        return event
      })

      // When searching, filter by term against event name, location name, city, address, state, and brand name
      if (isSearching) {
        const term = searchTerm.toLowerCase().trim()
        const matchingIds = new Set(
          result.documents
            .filter((doc) => {
              const name = (doc.name ?? '').toLowerCase()
              const locationName = (doc.locationName ?? '').toLowerCase()
              const city = (doc.city ?? '').toLowerCase()
              const address = (doc.address ?? '').toLowerCase()
              const state = (doc.state ?? '').toLowerCase()
              const client = doc.client ? clientsMap.get(doc.client as string) : null
              const brand = (client?.name ?? '').toLowerCase()
              return (
                name.includes(term) ||
                locationName.includes(term) ||
                city.includes(term) ||
                address.includes(term) ||
                state.includes(term) ||
                brand.includes(term)
              )
            })
            .map((d) => d.$id)
        )
        mappedEvents = mappedEvents.filter((e) => e.id && matchingIds.has(e.id))
      }

      // Filter by derived status when Active or Inactive is selected
      if (statusFilter === 'active') {
        mappedEvents = mappedEvents.filter((e) => e.status === 'Active')
      } else if (statusFilter === 'in_active') {
        mappedEvents = mappedEvents.filter((e) => e.status === 'Inactive')
      }

      // Pagination: when searching or status filter (Active/Inactive) use filtered count; otherwise use result.total
      const total = isSearching || needsClientSideStatusFilter ? mappedEvents.length : result.total
      const totalPagesCount = Math.ceil(total / pageSize)
      setTotalEvents(total)
      setTotalPages(totalPagesCount)

      if (totalPagesCount > 0 && page > totalPagesCount) {
        const lastValidPage = totalPagesCount
        setCurrentPage(lastValidPage)
        if (page !== lastValidPage) {
          return fetchEvents(lastValidPage)
        }
      } else if (totalPagesCount === 0) {
        setCurrentPage(1)
      }

      // Apply client-side brand sorting if needed (since brand is a relationship)
      if (sortField === 'brand') {
        mappedEvents = [...mappedEvents].sort((a, b) => {
          const comparison = a.brand.localeCompare(b.brand)
          return sortOrder === 'asc' ? comparison : -comparison
        })
      }

      // For search or Active/Inactive filter: paginate the filtered list; otherwise we already have one page of docs
      const eventsToShow = isSearching || needsClientSideStatusFilter
        ? mappedEvents.slice((page - 1) * pageSize, page * pageSize)
        : mappedEvents

      setEvents(eventsToShow)
      setCurrentPage(page)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch events'
      addNotification({
        type: 'error',
        title: 'Error Loading Events',
        message: errorMessage,
      })
      console.error('Error fetching events:', err)
    } finally {
      setIsLoading(false)
      setIsInitialLoad(false)
    }
  }

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      fetchEvents(page)
      // Scroll to top of table for better UX
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // Fetch full event document for editing
  const fetchEventForEdit = async (eventId: string): Promise<EventDocument | null> => {
    try {
      const eventDoc = await eventsService.getById(eventId)
      return eventDoc
    } catch (err) {
      console.error('Error fetching event for edit:', err)
      addNotification({
        type: 'error',
        title: 'Error Loading Event',
        message: 'Failed to load event details for editing.',
      })
      return null
    }
  }

  // Format event document for edit modal initialData
  const formatEventForEditModal = async (eventDoc: EventDocument) => {
    // Fetch category title if category relationship exists
    let categoryTitle = ''
    if (eventDoc.categories) {
      try {
        const category = await categoriesService.getById(eventDoc.categories as string)
        categoryTitle = category.title
      } catch (err) {
        console.error('Error fetching category:', err)
      }
    }

    // Fetch client name if client relationship exists
    let brandName = ''
    if (eventDoc.client) {
      try {
        const client = await clientsService.getById(eventDoc.client as string)
        brandName = client.name
      } catch (err) {
        console.error('Error fetching client:', err)
      }
    }

    // Format discount for the input field (single discount field, string)
    const formatDiscountForInput = (discount?: string): string => {
      if (discount == null || String(discount).trim() === '') return ''
      return String(discount).trim()
    }

    // Handle products - ensure it's always an array
    // Products are stored as comma-separated string in database, so we need to split it
    const productsArray = Array.isArray(eventDoc.products) 
      ? eventDoc.products 
      : eventDoc.products 
        ? typeof eventDoc.products === 'string'
          ? (eventDoc.products as string).split(',').map((p: string) => p.trim()).filter((p: string) => p.length > 0)
          : [eventDoc.products as unknown as string]
        : []

    // Extract latitude and longitude from location array if it exists
    let latitude = ''
    let longitude = ''
    if (eventDoc.location && Array.isArray(eventDoc.location) && eventDoc.location.length === 2) {
      longitude = eventDoc.location[0]?.toString() || ''
      latitude = eventDoc.location[1]?.toString() || ''
    }

    let locationName = (eventDoc.locationName && String(eventDoc.locationName).trim()) || ''
    let resolvedAddress = eventDoc.address || ''
    let resolvedCity = eventDoc.city || ''
    let resolvedState = eventDoc.state || ''
    let resolvedZipCode = eventDoc.zipCode || ''
    let resolvedLatitude = latitude
    let resolvedLongitude = longitude
    const locationId = (eventDoc as EventDocument & { locationId?: string }).locationId
    if (locationId) {
      try {
        const location = await locationsService.getById(locationId)
        if (location) {
          locationName = location.name || ''
          resolvedAddress = location.address || ''
          resolvedCity = location.city || ''
          resolvedState = location.state || ''
          resolvedZipCode = location.zipCode || ''
          if (location.location && Array.isArray(location.location) && location.location.length >= 2) {
            resolvedLongitude = location.location[0]?.toString() || ''
            resolvedLatitude = location.location[1]?.toString() || ''
          }
        }
      } catch (err) {
        console.error('Error fetching location for event:', err)
      }
    }

    // Derive date and time strings for form inputs using the event's timezone
    // to avoid device-local timezone shifts that can move events to previous/next day.
    // Use startTime when available (matches EventsTable display logic), otherwise fall back to date.
    const eventTimezone = eventDoc.timezone || appTimezone
    const baseDateForInput = eventDoc.startTime || eventDoc.date
    const { dateStr: eventDateForInput } = utcToAppTimeFormInputs(baseDateForInput, eventTimezone)
    const { timeStr: startTimeForInput } = utcToAppTimeFormInputs(eventDoc.startTime, eventTimezone)
    const { timeStr: endTimeForInput } = utcToAppTimeFormInputs(eventDoc.endTime, eventTimezone)

    return {
      eventName: eventDoc.name || '',
      eventDate: eventDateForInput,
      startTime: startTimeForInput,
      endTime: endTimeForInput,
      city: resolvedCity,
      address: resolvedAddress,
      state: resolvedState,
      zipCode: resolvedZipCode,
      locationName: locationName || undefined,
      locationId: locationId || undefined,
      category: categoryTitle,
      products: productsArray,
      discount: formatDiscountForInput(eventDoc.discount),
      discountImage: normalizeDiscountImageUrl(eventDoc.discountImageURL) || null,
      checkInCode: eventDoc.checkInCode || '',
      brandName: brandName,
      checkInPoints: eventDoc.checkInPoints?.toString() || '',
      reviewPoints: eventDoc.reviewPoints?.toString() || '',
      eventInfo: eventDoc.eventInfo || '',
      latitude: resolvedLatitude,
      longitude: resolvedLongitude,
      timezone: eventTimezone,
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

  // Parse CSV file
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parseCSV = (csvText: string): any[] => {
    const lines = csvText.split('\n').filter(line => line.trim())
    if (lines.length < 2) {
      throw new Error('CSV file must contain at least a header row and one data row')
    }

    // Parse header row
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
    
    // Normalize header names (case-insensitive, handle variations)
    const normalizeHeader = (header: string): string => {
      const lower = header.toLowerCase().trim()
      const headerMap: Record<string, string> = {
        // Required columns
        'event name': 'Event Name',
        'eventname': 'Event Name',
        'name': 'Event Name',
        'date': 'Date',
        'address': 'Address',
        'city': 'City',
        'state': 'State',
        'zip code': 'Zip Code',
        'zipcode': 'Zip Code',
        'zip': 'Zip Code',
        'brand name': 'Brand Name',
        'brandname': 'Brand Name',
        'brand': 'Brand Name',
        'points': 'Points',
        'point': 'Points',
        'location': 'Location',
        'location name': 'Location',
        'locationname': 'Location',
        // Optional columns
        'start time': 'Start Time',
        'starttime': 'Start Time',
        'end time': 'End Time',
        'endtime': 'End Time',
        'category': 'Category',
        'product type': 'Products',
        'producttype': 'Products',
        'products': 'Products',
        'discount': 'Discount',
        'discount image url': 'Discount Image URL',
        'discountimageurl': 'Discount Image URL',
        'discount image': 'Discount Image URL',
        'event info': 'Event Info',
        'eventinfo': 'Event Info',
        'check-in code': 'Check-in Code',
        'checkincode': 'Check-in Code',
        'checkin code': 'Check-in Code',
        'review points': 'Review Points',
        'reviewpoints': 'Review Points',
        'latitude': 'Latitude',
        'lat': 'Latitude',
        'longitude': 'Longitude',
        'lng': 'Longitude',
        'long': 'Longitude',
        'timezone': 'Timezone',
        'time zone': 'Timezone',
      }
      return headerMap[lower] || header
    }

    const normalizedHeaders = headers.map(normalizeHeader)
    
    // Required columns (aligned with CSVUploadModal)
    const requiredColumns = [
      'Brand Name',
      'Category',
      'Date',
      'End Time',
      'Event Info',
      'Event Name',
      'Location',
      'Points',
      'Products',
      'Review Points',
      'Start Time',
    ]
    const missingColumns = requiredColumns.filter(col => !normalizedHeaders.includes(col))
    
    if (missingColumns.length > 0) {
      throw new Error(`Missing required columns: ${missingColumns.join(', ')}`)
    }

    // Parse data rows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      // Handle CSV with quoted fields that may contain commas
      const values: string[] = []
      let currentValue = ''
      let inQuotes = false

      for (let j = 0; j < line.length; j++) {
        const char = line[j]
        if (char === '"') {
          inQuotes = !inQuotes
        } else if (char === ',' && !inQuotes) {
          values.push(currentValue.trim())
          currentValue = ''
        } else {
          currentValue += char
        }
      }
      values.push(currentValue.trim()) // Add last value

      // Map values to headers
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row: any = {}
      headers.forEach((header, index) => {
        const normalizedHeader = normalizeHeader(header)
        row[normalizedHeader] = values[index]?.replace(/^"|"$/g, '') || ''
      })

      // Only skip completely empty rows; rows with partial data
      // will be validated later in handleCSVUpload
      const isRowEmpty = Object.values(row).every(
        value => value == null || String(value).trim() === ''
      )
      if (!isRowEmpty) {
        data.push(row)
      }
    }

    return data
  }

  // Handle CSV bulk upload
  const handleCSVUpload = async (file: File) => {
    try {
      // Read CSV file
      const csvText = await file.text()
      
      // Parse CSV
      const csvData = parseCSV(csvText)
      const totalRows = csvData.length
      
      if (totalRows === 0) {
        throw new Error('No valid event data found in CSV file')
      }

      let successCount = 0
      let errorCount = 0
      const errors: string[] = []

      // Required field keys for row-level validation (must be non-empty)
      const requiredRowFields = [
        'Event Name',
        'Date',
        'Brand Name',
        'Location',
        'Products',
        'Category',
      ] as const

      // Process each row
      for (let i = 0; i < csvData.length; i++) {
        const row = csvData[i]
        try {
          // Row-level validation: required string fields must be non-empty
          for (const field of requiredRowFields) {
            const value = row[field]
            if (value == null || String(value).trim() === '') {
              throw new Error(`Missing or empty required field: ${field}`)
            }
          }

          // Parse date - handle multiple formats and normalize to YYYY-MM-DD
          const rawDateStr = row['Date'].trim()
          const rowTimezoneRaw = row['Timezone']?.trim() || ''
          let rowTimezone = appTimezone
          if (rowTimezoneRaw) {
            const timezoneResolution = resolveSupportedAppTimezone(rowTimezoneRaw)
            if (!timezoneResolution.ok) {
              throw new Error(timezoneResolution.error)
            }
            rowTimezone = timezoneResolution.timezone
          }

          let eventDateStr: string

          // Preferred: MM/DD/YYYY (e.g., "01/20/2026")
          if (/^\d{2}\/\d{2}\/\d{4}$/.test(rawDateStr)) {
            const [month, day, year] = rawDateStr.split('/')
            eventDateStr = `${year}-${month}-${day}`
          }
          // Also accept YYYY-MM-DD (e.g., "2026-01-20")
          else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDateStr)) {
            eventDateStr = rawDateStr
          }
          // Also accept DD-MM-YYYY (e.g., "20-01-2026")
          else if (/^\d{2}-\d{2}-\d{4}$/.test(rawDateStr)) {
            const [day, month, year] = rawDateStr.split('-')
            eventDateStr = `${year}-${month}-${day}`
          }
          // Fallback to default Date parsing, then format as YYYY-MM-DD
          else {
            const parsed = new Date(rawDateStr)
            if (isNaN(parsed.getTime())) {
              throw new Error(
                `Invalid date format: ${row['Date']}. Expected formats: MM/DD/YYYY (preferred), YYYY-MM-DD, or DD-MM-YYYY`
              )
            }
            const year = parsed.getFullYear()
            const month = String(parsed.getMonth() + 1).padStart(2, '0')
            const day = String(parsed.getDate()).padStart(2, '0')
            eventDateStr = `${year}-${month}-${day}`
          }

          // Validate event date is not in the past (same rule as Add Event form),
          // using the row timezone (or app timezone fallback) to avoid off-by-one issues.
          const nowIso = new Date().toISOString()
          const { dateStr: todayDateStr } = utcToAppTimeFormInputs(nowIso, rowTimezone)
          const todayUtc = appTimeToUTC(todayDateStr, '00:00', rowTimezone)
          const eventDateUtc = appTimeToUTC(eventDateStr, '00:00', rowTimezone)
          if (eventDateUtc.getTime() < todayUtc.getTime()) {
            throw new Error('Event date cannot be in the past. Please use today or a future date.')
          }

          // Use times from CSV or default values
          const startTimeRaw = row['Start Time']?.trim() || '00:00' // Default start time
          const endTimeRaw = row['End Time']?.trim()

          // Parse time string (supports HH:MM and optional AM/PM) and normalize to HH:mm
          const parseTimeString = (timeStr: string): { hours: number; minutes: number } => {
            const lower = timeStr.toLowerCase()
            const isPm = lower.includes('pm')
            const isAm = lower.includes('am')
            const cleanTime = timeStr.replace(/[APap][Mm]/, '').trim()
            const [hRaw, mRaw] = cleanTime.split(':')
            let hours = parseInt(hRaw ?? '0', 10)
            let minutes = parseInt(mRaw ?? '0', 10)
            if (Number.isNaN(hours)) hours = 0
            if (Number.isNaN(minutes)) minutes = 0
            if (isPm && hours < 12) hours += 12
            if (isAm && hours === 12) hours = 0
            return { hours, minutes }
          }

          const { hours: startHours, minutes: startMinutes } = parseTimeString(startTimeRaw)
          const startTimeStr = `${String(startHours).padStart(2, '0')}:${String(startMinutes).padStart(2, '0')}`

          let endTimeStr: string
          if (endTimeRaw) {
            const { hours: endHours, minutes: endMinutes } = parseTimeString(endTimeRaw)
            endTimeStr = `${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}`
          } else {
            // Default: same day at 23:59
            endTimeStr = '23:59'
          }

          // Validate start time is before end time (same rule as Add Event form),
          // comparing in the row timezone (or app timezone fallback).
          const startUtc = appTimeToUTC(eventDateStr, startTimeStr, rowTimezone)
          const endUtc = appTimeToUTC(eventDateStr, endTimeStr, rowTimezone)
          if (startUtc.getTime() >= endUtc.getTime()) {
            throw new Error('Start time must be before end time. Please adjust the event times.')
          }

          // Find client by brand name
          let clientId: string | null = null
          let client: ClientDocument | null = null
          if (row['Brand Name']) {
            try {
              client = await clientsService.findByName(row['Brand Name'].trim())
              clientId = client?.$id || null
              if (!clientId) {
                throw new Error(`Brand "${row['Brand Name']}" not found in database`)
              }
            } catch (brandErr) {
              throw new Error(`Brand lookup failed: ${extractErrorMessage(brandErr)}`)
            }
          }

          // Resolve category by name (required); reject invalid category
          const categoryName = row['Category'].trim()
          const category = await categoriesService.findByTitle(categoryName)
          if (!category) {
            throw new Error(`Category "${categoryName}" not found. Use an existing Category from the admin panel.`)
          }
          const categoryId = category.$id

          // Resolve Location by name (required)
          const locationName = row['Location']?.trim() || ''
          const locationDoc = await locationsService.findByName(locationName)
          if (!locationDoc) {
            throw new Error(`Location "${locationName}" not found. Use an existing Location name from the admin panel.`)
          }

          // Parse products (comma-separated) and sync new products to brand's product list
          const productsString = row['Products']?.trim() || ''
          const productsFromCsv = productsString
            ? productsString.split(',').map((p: string) => p.trim()).filter(Boolean)
            : []
          if (clientId && client && productsFromCsv.length > 0) {
            const existingProductType = client.productType || []
            const newProductNames = productsFromCsv.filter((name: string) => !existingProductType.includes(name))
            if (newProductNames.length > 0) {
              const mergedProductType = [...existingProductType, ...newProductNames]
              await clientsService.update(clientId, { productType: mergedProductType })
              client = { ...client, productType: mergedProductType }
            }
          }

          const checkInCode = await generateUniqueCheckInCode()

          // Check-in points (Points) and review points with defaults when empty
          const checkInPoints = parseFloat(row['Points']) || 10
          const reviewPoints = parseFloat(row['Review Points']) || 50

          const eventInfo = row['Event Info']?.trim() || 'Event info'

          const discount = row['Discount']?.trim() || ''
          const discountImageURL = normalizeDiscountImageUrl(row['Discount Image URL'])

          // Prepare event payload: address/geo from Location document
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const eventPayload: any = {
            name: row['Event Name'],
            date: appTimeToUTC(eventDateStr, '00:00', rowTimezone).toISOString(),
            startTime: startUtc.toISOString(),
            endTime: endUtc.toISOString(),
            city: locationDoc.city || '',
            address: locationDoc.address || '',
            state: locationDoc.state || '',
            zipCode: locationDoc.zipCode || '',
            timezone: rowTimezone,
            products: productsString,
            checkInCode,
            checkInPoints,
            reviewPoints,
            eventInfo,
            isArchived: false,
            isHidden: false,
          }

          if (locationDoc.location && Array.isArray(locationDoc.location) && locationDoc.location.length === 2) {
            eventPayload.location = locationDoc.location
          }

          if (locationDoc.name) {
            eventPayload.locationName = locationDoc.name
          }

          if (appwriteConfig.eventsHasLocationIdAttribute) {
            eventPayload.locationId = locationDoc.$id
          }

          if (discount) {
            eventPayload.discount = discount.trim()
          }
          if (discountImageURL) {
            eventPayload.discountImageURL = discountImageURL
          }

          // Add client if found
          if (clientId) {
            eventPayload.client = clientId
          }

          // Add category if found
          if (categoryId) {
            eventPayload.categories = categoryId
          }

          // Create event
          console.log(`Creating event for row ${i + 2}:`, eventPayload)
          await eventsService.create(eventPayload)
          successCount++
          console.log(`Successfully created event: ${row['Event Name']}`)
        } catch (err) {
          errorCount++
          const errorMsg = extractErrorMessage(err)
          const rowTimezoneRaw = row['Timezone']?.trim() || ''
          const timezoneContext = rowTimezoneRaw
            ? ` [Timezone: ${rowTimezoneRaw}]`
            : ` [Timezone: app default ${appTimezone}]`
          const errorDetail = `Row ${i + 2} (${row['Event Name'] || 'Unknown'}): ${errorMsg}${timezoneContext}`
          errors.push(errorDetail)
          console.error(`CSV Upload Error - ${errorDetail}`, err)
        }
      }

      // Show summary notification
      if (successCount > 0 && errorCount === 0) {
        addNotification({
          type: 'success',
          title: 'CSV Upload Successful',
          message: `Successfully created ${successCount} of ${totalRows} event${totalRows > 1 ? 's' : ''} from CSV file.`,
        })
      } else if (successCount > 0 && errorCount > 0) {
        addNotification({
          type: 'warning',
          title: 'Partial CSV Upload',
          message: `Created ${successCount} of ${totalRows} event${totalRows > 1 ? 's' : ''}, but ${errorCount} failed:\n${errors.slice(0, 3).join('\n')}${errors.length > 3 ? `\n... and ${errors.length - 3} more` : ''}`,
        })
        console.error('CSV Upload Errors (Full List):', errors)
      } else {
        const errorSummary = errors.slice(0, 3).join('\n') + (errors.length > 3 ? `\n... and ${errors.length - 3} more errors` : '')
        throw new Error(`Failed to create any events. ${errorCount} error${errorCount > 1 ? 's' : ''} occurred:\n\n${errorSummary}\n\nCheck console for full error details.`)
      }

      // Refresh events list - reset to page 1 after CSV upload
      setCurrentPage(1)
      await fetchEvents(1)
    } catch (err) {
      const errorMessage = extractErrorMessage(err)
      addNotification({
        type: 'error',
        title: 'CSV Upload Failed',
        message: errorMessage,
      })
      console.error('CSV upload error:', err)
      throw err
    }
  }

  // Handle event creation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCreateEvent = async (eventData: any) => {
    try {
      // 1. Use existing discount image URL if provided, otherwise upload new image file if present
      let discountImageURL: string | null = null
      if (typeof eventData.discountImage === 'string' && eventData.discountImage) {
        discountImageURL = normalizeDiscountImageUrl(eventData.discountImage)
      } else if (eventData.discountImage && eventData.discountImage instanceof File) {
        discountImageURL = await uploadFile(eventData.discountImage)
      }

      // 2. Find category by title (if category is provided)
      let categoryId: string | null = null
      if (eventData.category) {
        const category = await categoriesService.findByTitle(eventData.category)
        categoryId = category?.$id || null
      }

      // 3. Find client by brand name (if brandName is provided)
      let clientId: string | null = null
      if (eventData.brandName) {
        const client = await clientsService.findByName(eventData.brandName)
        clientId = client?.$id || null
        if (!clientId) {
          throw new Error(`Client with name "${eventData.brandName}" not found`)
        }
      }

      // 4. Convert event-timezone date/time to UTC for storage
      // 5. Prepare event data according to database schema
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eventPayload: any = {
        name: eventData.eventName,
        date: appTimeToUTC(eventData.eventDate, '00:00', eventData.timezone).toISOString(),
        startTime: appTimeToUTC(eventData.eventDate, eventData.startTime, eventData.timezone).toISOString(),
        endTime: appTimeToUTC(eventData.eventDate, eventData.endTime, eventData.timezone).toISOString(),
        city: eventData.city,
        address: eventData.address,
        state: eventData.state,
        zipCode: eventData.zipCode,
        products: Array.isArray(eventData.products) 
          ? eventData.products.join(', ') 
          : (eventData.products || ''),
        checkInCode: eventData.checkInCode,
        checkInPoints: parseFloat(eventData.checkInPoints) || 0,
        reviewPoints: parseFloat(eventData.reviewPoints) || 0,
        eventInfo: eventData.eventInfo,
        isArchived: false,
        isHidden: false,
        timezone: eventData.timezone,
      }

      // Optional fields
      if (categoryId) {
        eventPayload.categories = categoryId
      }

      if (clientId) {
        eventPayload.client = clientId
      }

      if (discountImageURL) {
        eventPayload.discountImageURL = discountImageURL
      }

      // Discount: single string field (text or number as string)
      if (eventData.discount !== undefined && eventData.discount !== '') {
        eventPayload.discount = String(eventData.discount).trim()
      }

      if (appwriteConfig.eventsHasLocationIdAttribute) {
        const trimmedLocationId =
          eventData.locationId != null && String(eventData.locationId).trim() !== ''
            ? String(eventData.locationId).trim()
            : ''
        if (!trimmedLocationId) {
          throw new Error('Please select an event location from the list (Location is required).')
        }
        await applyResolvedLocationToEventPayload(eventPayload, trimmedLocationId)
      } else {
        const trimmedLocationName =
          eventData.locationName != null && String(eventData.locationName).trim() !== ''
            ? String(eventData.locationName).trim()
            : ''
        if (trimmedLocationName) {
          eventPayload.locationName = trimmedLocationName
        }
        if (eventData.longitude && eventData.latitude) {
          const lat = parseFloat(eventData.latitude)
          const lng = parseFloat(eventData.longitude)
          
          // Validate coordinates before saving
          if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            eventPayload.location = [lng, lat] // [longitude, latitude] - GeoJSON format
            
            // Log for debugging
            console.log('Saving event with coordinates:', {
              lat,
              lng,
              location: [lng, lat]
            })
          } else {
            console.error('Invalid coordinates for event:', { lat, lng })
            eventPayload.location = null
          }
        }
      }

      // 6. Create event
      await eventsService.create(eventPayload)

      // 7. Show success notification
      addNotification({
        type: 'success',
        title: 'Event Created',
        message: `Event "${eventData.eventName}" has been created successfully.`,
      })

      // 8. Refresh events list - reset to page 1 after creating new event
      setCurrentPage(1)
      await fetchEvents(1)

      // 9. Close modal on success (modal will close automatically via onClose in AddEventModal)
    } catch (err) {
      // Extract error message from Appwrite error
      const errorMessage = extractErrorMessage(err)
      
      // Show error notification with actual Appwrite error message
      addNotification({
        type: 'error',
        title: 'Error Creating Event',
        message: errorMessage,
      })
      
      console.error('Error creating event:', err)
      
      // Re-throw error so modal can handle it (keep modal open)
      throw err
    }
  }

  // Handle event update
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleUpdateEvent = async (eventData: any) => {
    try {
      if (!selectedEventDoc) {
        throw new Error('No event selected for editing')
      }

      const eventId = selectedEventDoc.$id

      // 1. Resolve discount image update state
      let discountImageURL: string | null = null
      if (eventData.discountImage) {
        if (eventData.discountImage instanceof File) {
          // New file uploaded
          discountImageURL = await uploadFile(eventData.discountImage)
        } else if (typeof eventData.discountImage === 'string') {
          // Existing image URL, keep it
          discountImageURL = normalizeDiscountImageUrl(eventData.discountImage)
        }
      }
      const shouldClearDiscountImage = eventData.discountImage === null

      // 2. Find category by title (if category is provided)
      let categoryId: string | null = null
      if (eventData.category) {
        const category = await categoriesService.findByTitle(eventData.category)
        categoryId = category?.$id || null
      }

      // 3. Find client by brand name (if brandName is provided)
      let clientId: string | null = null
      if (eventData.brandName) {
        const client = await clientsService.findByName(eventData.brandName)
        clientId = client?.$id || null
        if (!clientId) {
          throw new Error(`Client with name "${eventData.brandName}" not found`)
        }
      }

      // 4. Convert event-timezone date/time to UTC for storage
      // 5. Prepare event data according to database schema
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eventPayload: any = {
        name: eventData.eventName,
        date: appTimeToUTC(eventData.eventDate, '00:00', eventData.timezone).toISOString(),
        startTime: appTimeToUTC(eventData.eventDate, eventData.startTime, eventData.timezone).toISOString(),
        endTime: appTimeToUTC(eventData.eventDate, eventData.endTime, eventData.timezone).toISOString(),
        city: eventData.city,
        address: eventData.address,
        state: eventData.state,
        zipCode: eventData.zipCode,
        products: Array.isArray(eventData.products) 
          ? eventData.products.join(', ') 
          : (eventData.products || ''),
        checkInCode: eventData.checkInCode,
        checkInPoints: parseFloat(eventData.checkInPoints) || 0,
        reviewPoints: parseFloat(eventData.reviewPoints) || 0,
        eventInfo: eventData.eventInfo,
        timezone: eventData.timezone ?? selectedEventDoc.timezone,
      }

      // Preserve existing status fields
      if (selectedEventDoc.isArchived !== undefined) {
        eventPayload.isArchived = selectedEventDoc.isArchived
      }
      if (selectedEventDoc.isHidden !== undefined) {
        eventPayload.isHidden = selectedEventDoc.isHidden
      }

      // Optional fields
      if (categoryId) {
        eventPayload.categories = categoryId
      } else if (selectedEventDoc.categories) {
        // Keep existing category if no new one provided
        eventPayload.categories = selectedEventDoc.categories
      }

      if (clientId) {
        eventPayload.client = clientId
      } else if (selectedEventDoc.client) {
        // Keep existing client if no new one provided
        eventPayload.client = selectedEventDoc.client
      }

      if (shouldClearDiscountImage) {
        eventPayload.discountImageURL = null
      } else if (discountImageURL) {
        eventPayload.discountImageURL = discountImageURL
      }

      // Discount: single string field (text or number as string)
      if (eventData.discount !== undefined && eventData.discount !== '') {
        eventPayload.discount = String(eventData.discount).trim()
      } else {
        eventPayload.discount = null
      }

      if (appwriteConfig.eventsHasLocationIdAttribute) {
        const trimmedLocationId =
          eventData.locationId != null && String(eventData.locationId).trim() !== ''
            ? String(eventData.locationId).trim()
            : ''
        if (!trimmedLocationId) {
          throw new Error('Please select an event location from the list (Location is required).')
        }
        await applyResolvedLocationToEventPayload(eventPayload, trimmedLocationId)
      } else {
        const trimmedLocationName =
          eventData.locationName != null && String(eventData.locationName).trim() !== ''
            ? String(eventData.locationName).trim()
            : ''
        eventPayload.locationName = trimmedLocationName || null
        if (eventData.longitude && eventData.latitude) {
          const lat = parseFloat(eventData.latitude)
          const lng = parseFloat(eventData.longitude)
          
          // Validate coordinates before saving
          if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            eventPayload.location = [lng, lat] // [longitude, latitude] - GeoJSON format
            
            // Log for debugging
            console.log('Saving event with coordinates:', {
              lat,
              lng,
              location: [lng, lat]
            })
          } else {
            console.error('Invalid coordinates for event:', { lat, lng })
            eventPayload.location = null
          }
        } else {
          eventPayload.location = null
        }
      }

      // 6. Update event
      await eventsService.update(eventId, eventPayload)

      // 7. Show success notification
      addNotification({
        type: 'success',
        title: 'Event Updated',
        message: `Event "${eventData.eventName}" has been updated successfully.`,
      })

      // 8. Refresh events list
      await fetchEvents(currentPage)

      // 9. Close modal on success
      setIsEditModalOpen(false)
      setSelectedEvent(null)
      setSelectedEventDoc(null)
      setEditModalInitialData(null)
    } catch (err) {
      // Extract error message from Appwrite error
      const errorMessage = extractErrorMessage(err)
      
      // Show error notification with actual Appwrite error message
      addNotification({
        type: 'error',
        title: 'Error Updating Event',
        message: errorMessage,
      })
      
      console.error('Error updating event:', err)
      
      // Re-throw error so modal can handle it (keep modal open)
      throw err
    }
  }

  // Fetch statistics
  const fetchStatistics = async () => {
    try {
      const stats = await statisticsService.getStatistics<DashboardStats>('dashboard')
      setStatistics(stats)
    } catch (err) {
      console.error('Error fetching statistics:', err)
      addNotification({
        type: 'error',
        title: 'Error Loading Statistics',
        message: 'Failed to load dashboard statistics. Please refresh the page.',
      })
    }
  }

  // Map statistics to metrics format
  const metrics = statistics
    ? [
        {
          label: 'Total Clients/Brands',
          value: formatNumber(statistics.totalClientsBrands),
          change: formatPercentage(statistics.totalClientsBrandsChange),
          changeLabel: 'from last month',
          icon: 'mdi:file-document',
          iconBg: 'bg-blue-100',
          iconColor: 'text-blue-600',
        },
        {
          label: 'Total Points Awarded',
          value: formatNumber(statistics.totalPointsAwarded),
          change: formatPercentage(statistics.totalPointsAwardedChange),
          changeLabel: 'from last month',
          icon: 'mdi:ribbon',
          iconBg: 'bg-green-100',
          iconColor: 'text-green-600',
        },
        {
          label: 'Total Users', 
          value: formatNumber(statistics.totalUsers),
          change: formatPercentage(statistics.totalUsersChange),
          changeLabel: 'from last month',
          icon: 'mdi:account-group',
          iconBg: 'bg-purple-100',
          iconColor: 'text-[#1D0A74]',
        },
        {
          label: 'Average PPU',
          value: formatNumber(statistics.averagePPU),
          change: formatPercentage(statistics.averagePPUChange),
          changeLabel: 'from last month',
          icon: 'mdi:trending-up',
          iconBg: 'bg-orange-100',
          iconColor: 'text-orange-600',
        },
        {
          label: 'Total Check-ins',
          value: formatNumber(statistics.totalCheckins),
          change: formatPercentage(statistics.totalCheckinsChange),
          changeLabel: 'from last month',
          icon: 'mdi:check-circle',
          iconBg: 'bg-teal-100',
          iconColor: 'text-teal-600',
        },
        {
          label: 'Reviews',
          value: formatNumber(statistics.reviews),
          change: formatPercentage(statistics.reviewsChange),
          changeLabel: 'from last month',
          icon: 'mdi:star',
          iconBg: 'bg-yellow-100',
          iconColor: 'text-yellow-600',
        },
      ]
    : [
        {
          label: 'Total Clients/Brands',
          value: '0',
          change: '+0%',
          changeLabel: 'from last month',
          icon: 'mdi:file-document',
          iconBg: 'bg-blue-100',
          iconColor: 'text-blue-600',
        },
        {
          label: 'Total Points Awarded',
          value: '0',
          change: '+0%',
          changeLabel: 'from last month',
          icon: 'mdi:ribbon',
          iconBg: 'bg-green-100',
          iconColor: 'text-green-600',
        },
        {
          label: 'Total Users',
          value: '0',
          change: '+0%',
          changeLabel: 'from last month',
          icon: 'mdi:account-group',
          iconBg: 'bg-purple-100',
          iconColor: 'text-[#1D0A74]',
        },
        {
          label: 'Average PPU',
          value: '0',
          change: '+0%',
          changeLabel: 'from last month',
          icon: 'mdi:trending-up',
          iconBg: 'bg-orange-100',
          iconColor: 'text-orange-600',
        },
        {
          label: 'Total Check-ins',
          value: '0',
          change: '+0%',
          changeLabel: 'from last month',
          icon: 'mdi:check-circle',
          iconBg: 'bg-teal-100',
          iconColor: 'text-teal-600',
        },
        {
          label: 'Reviews',
          value: '0',
          change: '+0%',
          changeLabel: 'from last month',
          icon: 'mdi:star',
          iconBg: 'bg-yellow-100',
          iconColor: 'text-yellow-600',
        },
      ]

  // Fetch categories
  const fetchCategories = async () => {
    try {
      const result = await categoriesService.list()
      setCategories(result.documents as Array<Models.Document & { title: string }>)
    } catch (err) {
      console.error('Error fetching categories:', err)
      // Don't show notification for categories fetch failure
    }
  }

  // Fetch brands/clients
  const fetchBrands = async () => {
    try {
      const allClients = await clientsService.listAll()
      setBrands(allClients as Array<Models.Document & { name: string }>)
    } catch (err) {
      console.error('Error fetching brands:', err)
      // Don't show notification for brands fetch failure
    }
  }

  // Fetch events when filters, search, or sort change
  useEffect(() => {
    setCurrentPage(1) // Reset to first page when filters change
    fetchEvents(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, statusFilter, sortBy, dateRange.start, dateRange.end, appTimezone])

  // Fetch categories, brands, and statistics on component mount
  // OPTIMIZATION: Fetch all initial data in parallel
  useEffect(() => {
    Promise.all([
      fetchCategories(),
      fetchBrands(),
      fetchStatistics()
    ]).catch(err => {
      console.error('Error fetching initial data:', err)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (isLoading && isInitialLoad) {
    return (
      <DashboardLayout>
        <ShimmerPage />
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="p-8">
        <DashboardHeader />
        <MetricsCards metrics={metrics} />
        <SearchAndFilter
          onDateFilterClick={() => setIsDateFilterOpen(true)}
          dateRange={dateRange}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          sortBy={sortBy}
          onSortByChange={(value: string) => {
            setSortBy(value)
          }}
          appTimezone={appTimezone}
        />
        <EventsTable
          events={events}
          isLoading={isLoading}
          searchTerm={searchTerm}
          hasFilters={statusFilter !== 'all' || !!dateRange.start || !!dateRange.end}
          currentPage={currentPage}
          totalPages={totalPages}
          totalEvents={totalEvents}
          pageSize={pageSize}
          onPageChange={handlePageChange}
          onEventClick={async (event: Event) => {
            setSelectedEvent(event as Event)
            
            // Fetch full event document for editing BEFORE opening modal
            const eventId = (event as Event & { id?: string }).id
            if (eventId) {
              const eventDoc = await fetchEventForEdit(eventId)
              setSelectedEventDoc(eventDoc)
              
              if (eventDoc) {
                // Format event data for edit modal
                const formattedData = await formatEventForEditModal(eventDoc)
                setEditModalInitialData(formattedData)
                // Open modal only after data is ready
                setIsEditModalOpen(true)
              }
            }
          }}
          onReviewClick={(event) => {
            const eventId = (event as Event & { id?: string }).id
            if (eventId) {
              navigate(`/event-reviews/${eventId}`)
            } else {
              navigate('/event-reviews')
            }
          }}
          onEditClick={async (event: Event) => {
            setSelectedEvent(event as Event)
            
            // Fetch full event document for editing BEFORE opening modal
            const eventId = (event as Event & { id?: string }).id
            if (eventId) {
              const eventDoc = await fetchEventForEdit(eventId)
              setSelectedEventDoc(eventDoc)
              
              if (eventDoc) {
                // Format event data for edit modal
                const formattedData = await formatEventForEditModal(eventDoc)
                setEditModalInitialData(formattedData)
                // Open modal only after data is ready
                setIsEditModalOpen(true)
              }
            }
          }}
          onHideClick={(event) => {
            const isCurrentlyHidden = event.status === 'Hidden'
            setSelectedEvent(event)
            setConfirmationModal({
              isOpen: true,
              type: isCurrentlyHidden ? 'unhide' : 'hide',
              onConfirm: async () => {
                try {
                  const eventId = (event as Event & { id?: string }).id
                  if (!eventId) {
                    throw new Error('Event ID not found')
                  }
                  await eventsService.update(eventId, { isHidden: !isCurrentlyHidden })
                  addNotification({
                    type: 'success',
                    title: isCurrentlyHidden ? 'Event Unhidden' : 'Event Hidden',
                    message: `Event "${event.venueName}" has been ${isCurrentlyHidden ? 'unhidden' : 'hidden'} successfully.`,
                  })
                  setConfirmationModal({ ...confirmationModal, isOpen: false })
                  await fetchEvents(currentPage)
                } catch (err) {
                  const errorMessage = extractErrorMessage(err)
                  addNotification({
                    type: 'error',
                    title: isCurrentlyHidden ? 'Error Unhiding Event' : 'Error Hiding Event',
                    message: errorMessage,
                  })
                  console.error('Error toggling event visibility:', err)
                }
              },
              itemName: `event "${event.venueName}"`,
            })
          }}
          onDeleteClick={(event) => {
            setSelectedEvent(event)
            setConfirmationModal({
              isOpen: true,
              type: 'delete',
              onConfirm: async () => {
                try {
                  const eventId = (event as Event & { id?: string }).id
                  if (!eventId) {
                    throw new Error('Event ID not found')
                  }
                  await eventsService.delete(eventId)
                  addNotification({
                    type: 'success',
                    title: 'Event Deleted',
                    message: `Event "${event.venueName}" has been deleted successfully.`,
                  })
                  setConfirmationModal({ ...confirmationModal, isOpen: false })
                  await fetchEvents(currentPage)
                } catch (err) {
                  const errorMessage = extractErrorMessage(err)
                  addNotification({
                    type: 'error',
                    title: 'Error Deleting Event',
                    message: errorMessage,
                  })
                  console.error('Error deleting event:', err)
                }
              },
              itemName: `event "${event.venueName}"`,
            })
          }}
          onCSVUpload={() => setIsCSVUploadOpen(true)}
          onNewEvent={() => setIsModalOpen(true)}
        />
      </div>

      {/* Add Event Modal */}
      <AddEventModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false)
          setAddModalInitialData(undefined)
        }}
        onSave={handleCreateEvent}
        categories={categories}
        brands={brands}
        initialData={addModalInitialData}
      />

      {/* Edit Event Modal */}
      <EditEventModal
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false)
          setSelectedEvent(null)
          setSelectedEventDoc(null)
          setEditModalInitialData(null)
        }}
        onSave={handleUpdateEvent}
        eventId={selectedEventDoc?.$id}
        isArchived={selectedEventDoc?.isArchived === true}
        isHidden={selectedEventDoc?.isHidden === true}
        onDuplicate={() => {
          // Close edit modal
          setIsEditModalOpen(false)
          // Open add modal with current event data
          if (editModalInitialData) {
            setAddModalInitialData(editModalInitialData)
            setIsModalOpen(true)
          }
          // Clear edit modal state
          setSelectedEvent(null)
          setSelectedEventDoc(null)
          setEditModalInitialData(null)
        }}
        onShowArchiveConfirm={() => {
          setConfirmationModal({
            isOpen: true,
            type: 'archive',
            onConfirm: async () => {
              try {
                const eventId = selectedEventDoc?.$id || (selectedEvent as Event & { id?: string })?.id
                if (!eventId) {
                  throw new Error('Event ID not found')
                }
                await eventsService.update(eventId, { isArchived: true })
                addNotification({
                  type: 'success',
                  title: 'Event Archived',
                  message: `Event has been archived successfully.`,
                })
                setConfirmationModal({ ...confirmationModal, isOpen: false })
                setIsEditModalOpen(false)
                setSelectedEvent(null)
                setSelectedEventDoc(null)
                setEditModalInitialData(null)
                await fetchEvents(currentPage)
              } catch (err) {
                const errorMessage = extractErrorMessage(err)
                addNotification({
                  type: 'error',
                  title: 'Error Archiving Event',
                  message: errorMessage,
                })
                console.error('Error archiving event:', err)
              }
            },
            itemName: (selectedEvent as Event | null)?.venueName
              ? `event "${(selectedEvent as Event).venueName}"`
              : 'this event',
          })
        }}
        onShowUnarchiveConfirm={() => {
          setConfirmationModal({
            isOpen: true,
            type: 'unarchive',
            onConfirm: async () => {
              try {
                const eventId = selectedEventDoc?.$id || (selectedEvent as Event & { id?: string })?.id
                if (!eventId) {
                  throw new Error('Event ID not found')
                }
                await eventsService.update(eventId, { isArchived: false })
                addNotification({
                  type: 'success',
                  title: 'Event Unarchived',
                  message: `Event has been restored from the archive.`,
                })
                setConfirmationModal({ ...confirmationModal, isOpen: false })
                setIsEditModalOpen(false)
                setSelectedEvent(null)
                setSelectedEventDoc(null)
                setEditModalInitialData(null)
                await fetchEvents(currentPage)
              } catch (err) {
                const errorMessage = extractErrorMessage(err)
                addNotification({
                  type: 'error',
                  title: 'Error Unarchiving Event',
                  message: errorMessage,
                })
                console.error('Error unarchiving event:', err)
              }
            },
            itemName: (selectedEvent as Event | null)?.venueName
              ? `event "${(selectedEvent as Event).venueName}"`
              : 'this event',
          })
        }}
        onShowHideConfirm={() => {
          setConfirmationModal({
            isOpen: true,
            type: 'hide',
            onConfirm: async () => {
              try {
                const eventId = selectedEventDoc?.$id || (selectedEvent as Event & { id?: string })?.id
                if (!eventId) {
                  throw new Error('Event ID not found')
                }
                await eventsService.update(eventId, { isHidden: true })
                addNotification({
                  type: 'success',
                  title: 'Event Hidden',
                  message: `Event has been hidden successfully.`,
                })
                setConfirmationModal({ ...confirmationModal, isOpen: false })
                setIsEditModalOpen(false)
                setSelectedEvent(null)
                setSelectedEventDoc(null)
                setEditModalInitialData(null)
                await fetchEvents(currentPage)
              } catch (err) {
                const errorMessage = extractErrorMessage(err)
                addNotification({
                  type: 'error',
                  title: 'Error Hiding Event',
                  message: errorMessage,
                })
                console.error('Error hiding event:', err)
              }
            },
            itemName: (selectedEvent as Event | null)?.venueName
              ? `event "${(selectedEvent as Event).venueName}"`
              : 'this event',
          })
        }}
        onShowUnhideConfirm={() => {
          setConfirmationModal({
            isOpen: true,
            type: 'unhide',
            onConfirm: async () => {
              try {
                const eventId = selectedEventDoc?.$id || (selectedEvent as Event & { id?: string })?.id
                if (!eventId) {
                  throw new Error('Event ID not found')
                }
                await eventsService.update(eventId, { isHidden: false })
                addNotification({
                  type: 'success',
                  title: 'Event Unhidden',
                  message: `Event is visible to users again.`,
                })
                setConfirmationModal({ ...confirmationModal, isOpen: false })
                setIsEditModalOpen(false)
                setSelectedEvent(null)
                setSelectedEventDoc(null)
                setEditModalInitialData(null)
                await fetchEvents(currentPage)
              } catch (err) {
                const errorMessage = extractErrorMessage(err)
                addNotification({
                  type: 'error',
                  title: 'Error Unhiding Event',
                  message: errorMessage,
                })
                console.error('Error unhiding event:', err)
              }
            },
            itemName: (selectedEvent as Event | null)?.venueName
              ? `event "${(selectedEvent as Event).venueName}"`
              : 'this event',
          })
        }}
        onShowDeleteConfirm={() => {
          setConfirmationModal({
            isOpen: true,
            type: 'delete',
            onConfirm: async () => {
              try {
                const eventId = selectedEventDoc?.$id || (selectedEvent as Event & { id?: string })?.id
                if (!eventId) {
                  throw new Error('Event ID not found')
                }
                await eventsService.delete(eventId)
                addNotification({
                  type: 'success',
                  title: 'Event Deleted',
                  message: `Event has been deleted successfully.`,
                })
                setConfirmationModal({ ...confirmationModal, isOpen: false })
                setIsEditModalOpen(false)
                setSelectedEvent(null)
                setSelectedEventDoc(null)
                setEditModalInitialData(null)
                await fetchEvents(currentPage)
              } catch (err) {
                const errorMessage = extractErrorMessage(err)
                addNotification({
                  type: 'error',
                  title: 'Error Deleting Event',
                  message: errorMessage,
                })
                console.error('Error deleting event:', err)
              }
            },
            itemName: (selectedEvent as Event | null)?.venueName
              ? `event "${(selectedEvent as Event).venueName}"`
              : 'this event',
          })
        }}
        initialData={editModalInitialData || undefined}
        categories={categories}
        brands={brands}
      />

      {/* Date Filter Modal */}
      <DateFilterModal
        isOpen={isDateFilterOpen}
        onClose={() => setIsDateFilterOpen(false)}
        onSelect={(startDate: Date | null, endDate: Date | null) => {
          setDateRange({ start: startDate, end: endDate })
          // Date filter is automatically applied via useEffect
        }}
        initialStartDate={dateRange.start}
        initialEndDate={dateRange.end}
      />

      {/* CSV Upload Modal */}
      <CSVUploadModal
        isOpen={isCSVUploadOpen}
        onClose={() => setIsCSVUploadOpen(false)}
        onUpload={handleCSVUpload}
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

export default Dashboard

