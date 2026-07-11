import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Models } from 'appwrite'
import {
  DashboardLayout,
  ConfirmationModal,
  ShimmerPage,
} from '../../components'
import {
  TriviaHeader,
  SearchAndFilter,
  TriviaTable,
  CreateTriviaModal,
  EditTriviaModal,
  StatsCards,
} from './components'
import { triviaService, triviaResponsesService, clientsService, statisticsService, userProfilesService, isCorrectTriviaResponse, type TriviaStats, type TriviaDocument as ServiceTriviaDocument, type TriviaResponseDocument, type ClientDocument, type UserProfile } from '../../lib/services'
import type { TriviaWinner } from './components/TriviaTable'
import { useNotificationStore } from '../../stores/notificationStore'
import { useTimezoneStore } from '../../stores/timezoneStore'
import { formatDateInAppTimezone } from '../../lib/dateUtils'
import { Query } from '../../lib/appwrite'

// Use ServiceTriviaDocument from services.ts
type TriviaDocument = ServiceTriviaDocument

// UI Trivia Quiz interface (for display)
interface TriviaQuiz {
  id: string
  question: string
  date: string
  responses: number
  winners: TriviaWinner[]
  view: number
  skip: number
  incorrect: number
  winnersCount: number
  status: 'Scheduled' | 'Active' | 'Completed' | 'Draft'
  clientName?: string
}

const Trivia = () => {
  const navigate = useNavigate()
  const { addNotification } = useNotificationStore()
  const { appTimezone } = useTimezoneStore()
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isListLoading, setIsListLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'status' | 'responses' | 'view' | 'skip' | 'incorrect' | 'winners'>('date')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [triviaToDelete, setTriviaToDelete] = useState<TriviaQuiz | null>(null)
  const [isDeletingTrivia, setIsDeletingTrivia] = useState(false)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [triviaToEdit, setTriviaToEdit] = useState<TriviaQuiz | null>(null)
  const [triviaQuizzes, setTriviaQuizzes] = useState<TriviaQuiz[]>([])
  const [statistics, setStatistics] = useState<TriviaStats | null>(null)
  const [clientsMap, setClientsMap] = useState<Map<string, ClientDocument>>(new Map())
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalTrivia, setTotalTrivia] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  // Only the latest fetch may commit — search/computed-sort now page the full set (multiple
  // round-trips), so a slower earlier fetch could otherwise resolve after a newer one and overwrite
  // it (or recurse on stale state). Guarded before every setState that reflects results.
  const fetchIdRef = useRef(0)

  // Fetch clients map for displaying client names
  const fetchClients = async () => {
    try {
      const result = await clientsService.listAll()
      const map = new Map<string, ClientDocument>()
      result.forEach((client) => {
        map.set(client.$id, client)
      })
      setClientsMap(map)
    } catch (err) {
      console.error('Error fetching clients:', err)
    }
  }

  // Transform TriviaDocument to TriviaQuiz for UI with statistics
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transformToUITrivia = async (doc: TriviaDocument, responses: any[]): Promise<TriviaQuiz> => {
    // Calculate status from dates
    const now = new Date()
    const startDate = doc.startDate ? new Date(doc.startDate) : null
    const endDate = doc.endDate ? new Date(doc.endDate) : null
    
    let status: 'Scheduled' | 'Active' | 'Completed' | 'Draft' = 'Draft'
    if (startDate && endDate) {
      if (now < startDate) {
        status = 'Scheduled'
      } else if (now > endDate) {
        status = 'Completed'
      } else {
        status = 'Active' // Between start and end date = Active
      }
    }

    // Format date from startDate or createdAt (in app timezone)
    const date = doc.startDate
      ? formatDateInAppTimezone(doc.startDate, appTimezone)
      : doc.$createdAt
      ? formatDateInAppTimezone(doc.$createdAt, appTimezone)
      : 'N/A'

    // Calculate statistics from responses (normalize to number; Appwrite may return integers as strings)
    const correctResponses = responses.filter((response) =>
      isCorrectTriviaResponse(response, doc.correctOptionIndex)
    )
    const incorrectResponses = responses.filter(
      (response) => !isCorrectTriviaResponse(response, doc.correctOptionIndex)
    )
    
    // Get unique users who answered correctly (winners)
    // Handle both string IDs and expanded relationship objects
    const uniqueWinnerData = Array.from(
      new Set(correctResponses.map((r) => {
        const user = r.user
        // If user is already an expanded object, extract the ID
        if (typeof user === 'object' && user !== null && '$id' in user) {
          return (user as { $id: string }).$id
        }
        return user as string
      }).filter(Boolean))
    ).slice(0, 10) as string[]
    
    // Fetch user profiles for winners in parallel for better performance
    const winnerProfiles: TriviaWinner[] = await Promise.all(
      uniqueWinnerData.map(async (userId) => {
        try {
          const profile = await userProfilesService.getById(userId) as UserProfile | null
          if (profile) {
            return {
              id: profile.$id,
              username: profile.username || undefined,
              firstname: profile.firstname || undefined,
              lastname: profile.lastname || undefined,
              avatarURL: profile.avatarURL || undefined,
            }
          }
        } catch {
          // Profile fetch failed, continue with fallback
        }
        // Fallback: return with just ID if profile not found or fetch failed
        return { id: userId }
      })
    )
    
    // Get client name
    const clientName = doc.client && clientsMap.has(doc.client) 
      ? clientsMap.get(doc.client)!.name 
      : undefined

    return {
      id: doc.$id,
      question: doc.question || 'No question',
      date,
      responses: responses.length,
      winners: winnerProfiles,
      view: Math.max(doc.views || 0, responses.length + (doc.skips || 0)),
      skip: doc.skips || 0,
      incorrect: incorrectResponses.length,
      winnersCount: correctResponses.length,
      status,
      clientName,
    }
  }

  // Fetch trivia from Appwrite with statistics and pagination
  const fetchTrivia = async (page: number = currentPage, isInitial: boolean = false) => {
    const thisFetchId = ++fetchIdRef.current
    try {
      if (isInitial) {
        setIsInitialLoading(true)
      } else {
        setIsListLoading(true)
      }
      setError(null)
      
      // Fetch clients first if not already loaded
      if (clientsMap.size === 0) {
        await fetchClients()
      }
      
      const trimmedSearch = searchQuery.trim()
      const isSearching = trimmedSearch.length > 0
      const direction = sortOrder === 'asc' ? 1 : -1

      // Sort fields split into server-orderable (stored on the trivia doc) vs. client-computed.
      const serverOrderField: Record<string, string> = { date: 'startDate', name: 'question', skip: 'skips' }
      const isComputedSort = !(sortBy in serverOrderField)
      const needsResponsesForSort =
        sortBy === 'responses' || sortBy === 'view' || sortBy === 'incorrect' || sortBy === 'winners'
      // Search and computed sorts must operate over the FULL set: a single fetched page would search
      // and sort only ~25 rows, hiding matches and mis-ordering across pages. Browsing by a
      // server-orderable field keeps efficient server-side pagination.
      const needFullSet = isSearching || isComputedSort

      const statusOf = (doc: TriviaDocument): 'Scheduled' | 'Active' | 'Completed' | 'Draft' => {
        const now = new Date()
        const start = doc.startDate ? new Date(doc.startDate) : null
        const end = doc.endDate ? new Date(doc.endDate) : null
        if (start && end) {
          if (now < start) return 'Scheduled'
          if (now > end) return 'Completed'
          return 'Active'
        }
        return 'Draft'
      }
      // Sort key mirrors the values shown in the table (see transformToUITrivia).
      const sortKeyOf = (doc: TriviaDocument, responses: TriviaResponseDocument[] | null): number | string => {
        switch (sortBy) {
          case 'name':
            return (doc.question || '').toLowerCase()
          case 'status':
            return statusOf(doc)
          case 'skip':
            return Number(doc.skips || 0)
          case 'responses':
            return responses ? responses.length : 0
          case 'view':
            return Math.max(Number(doc.views || 0), (responses?.length || 0) + Number(doc.skips || 0))
          case 'incorrect':
            return responses ? responses.filter((r) => !isCorrectTriviaResponse(r, doc.correctOptionIndex)).length : 0
          case 'winners':
            return responses ? responses.filter((r) => isCorrectTriviaResponse(r, doc.correctOptionIndex)).length : 0
          case 'date':
          default:
            return doc.startDate
              ? new Date(doc.startDate).getTime()
              : doc.$createdAt
              ? new Date(doc.$createdAt).getTime()
              : 0
        }
      }

      let pageDocs: TriviaDocument[]
      let pageResponses: TriviaResponseDocument[][]

      if (needFullSet) {
        // Fetch the FULL matched set (searchAll pages through everything, honoring the search term).
        const searchResult = await triviaService.searchAll(trimmedSearch, [Query.orderDesc('startDate')])
        const matchedDocs = searchResult.documents as TriviaDocument[]

        // Fetch responses for everyone only when the sort ranks on response-derived counts.
        const allResponses: (TriviaResponseDocument[] | null)[] = needsResponsesForSort
          ? await Promise.all(matchedDocs.map((doc) => triviaResponsesService.getByTriviaId(doc.$id).catch(() => [])))
          : matchedDocs.map(() => null)

        const indexed = matchedDocs.map((doc, i) => ({ doc, responses: allResponses[i] }))
        indexed.sort((a, b) => {
          const ka = sortKeyOf(a.doc, a.responses)
          const kb = sortKeyOf(b.doc, b.responses)
          if (typeof ka === 'string' || typeof kb === 'string') {
            return direction * String(ka).localeCompare(String(kb), undefined, { sensitivity: 'base' })
          }
          return direction * ((ka as number) - (kb as number))
        })

        const total = indexed.length
        const totalPagesCount = Math.ceil(total / pageSize)
        // Discard if superseded — also stops a stale fetch from recursing on old state below.
        if (thisFetchId !== fetchIdRef.current) return
        setTotalTrivia(total)
        setTotalPages(totalPagesCount)
        if (totalPagesCount > 0 && page > totalPagesCount) {
          const lastValidPage = totalPagesCount
          setCurrentPage(lastValidPage)
          if (page !== lastValidPage) {
            return fetchTrivia(lastValidPage, false)
          }
        } else if (totalPagesCount === 0) {
          setCurrentPage(1)
        }

        const pageSlice = indexed.slice((page - 1) * pageSize, page * pageSize)
        pageDocs = pageSlice.map((e) => e.doc)
        // Reuse responses fetched for sorting; otherwise fetch just for the visible page.
        pageResponses = needsResponsesForSort
          ? pageSlice.map((e) => e.responses ?? [])
          : await Promise.all(pageDocs.map((doc) => triviaResponsesService.getByTriviaId(doc.$id).catch(() => [])))
      } else {
        // Browse by a server-orderable field: efficient server-side pagination.
        const orderMethod = sortOrder === 'asc' ? Query.orderAsc : Query.orderDesc
        const listResult = await triviaService.list([
          orderMethod(serverOrderField[sortBy]),
          Query.limit(pageSize),
          Query.offset((page - 1) * pageSize),
        ])

        const total = listResult.total
        const totalPagesCount = Math.ceil(total / pageSize)
        // Discard if superseded — also stops a stale fetch from recursing on old state below.
        if (thisFetchId !== fetchIdRef.current) return
        setTotalTrivia(total)
        setTotalPages(totalPagesCount)
        if (totalPagesCount > 0 && page > totalPagesCount) {
          const lastValidPage = totalPagesCount
          setCurrentPage(lastValidPage)
          if (page !== lastValidPage) {
            return fetchTrivia(lastValidPage, false)
          }
        } else if (totalPagesCount === 0) {
          setCurrentPage(1)
        }

        pageDocs = listResult.documents as TriviaDocument[]
        pageResponses = await Promise.all(
          pageDocs.map((doc) => triviaResponsesService.getByTriviaId(doc.$id).catch(() => []))
        )
      }

      // Transform only the current page (winner profiles are fetched here, so keep this bounded).
      const transformedTrivia = await Promise.all(
        pageDocs.map((doc, index) => transformToUITrivia(doc, pageResponses[index]))
      )
      // Discard this result if a newer fetch has started during the transform (avoids stale overwrite).
      if (thisFetchId !== fetchIdRef.current) return
      setTriviaQuizzes(transformedTrivia)
      setCurrentPage(page)
    } catch (err) {
      console.error('Error fetching trivia:', err)
      setError('Failed to load trivia quizzes. Please try again.')
    } finally {
      // Only the latest fetch clears the loading state.
      if (thisFetchId === fetchIdRef.current) {
        if (isInitial) {
          setIsInitialLoading(false)
        } else {
          setIsListLoading(false)
        }
      }
    }
  }

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      fetchTrivia(page, false)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // Fetch statistics
  const fetchStatistics = async () => {
    try {
      const stats = await statisticsService.getStatistics<TriviaStats>('trivia')
      setStatistics(stats)
    } catch (err) {
      console.error('Error fetching statistics:', err)
      addNotification({
        type: 'error',
        title: 'Error Loading Statistics',
        message: 'Failed to load trivia statistics. Please refresh the page.',
      })
    }
  }

  // Initial load
  useEffect(() => {
    const initialLoad = async () => {
      await fetchClients()
      await fetchTrivia(1, true)
      await fetchStatistics()
    }
    initialLoad()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reset to page 1 when search or sort changes (not initial load)
  useEffect(() => {
    if (!isInitialLoading) {
      setCurrentPage(1)
      fetchTrivia(1, false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, sortBy, sortOrder, appTimezone])

  const handleDeleteClick = (trivia: TriviaQuiz) => {
    setTriviaToDelete(trivia)
    setIsDeleteModalOpen(true)
  }

  const handleConfirmDelete = async () => {
    if (triviaToDelete?.id) {
      setIsDeletingTrivia(true)
      try {
        await triviaService.delete(triviaToDelete.id)
        // Check if we need to go back a page if current page becomes empty
        if (triviaQuizzes.length === 1 && currentPage > 1) {
          setCurrentPage(currentPage - 1)
          await Promise.all([fetchTrivia(currentPage - 1, false), fetchStatistics()])
        } else {
          await Promise.all([fetchTrivia(currentPage, false), fetchStatistics()])
        }
        addNotification({
          type: 'success',
          title: 'Trivia Deleted',
          message: 'The trivia quiz has been successfully deleted.',
        })
        setTriviaToDelete(null)
        setIsDeleteModalOpen(false)
      } catch (err) {
        console.error('Error deleting trivia:', err)
        addNotification({
          type: 'error',
          title: 'Delete Failed',
          message: 'Failed to delete trivia quiz. Please try again.',
        })
        setIsDeleteModalOpen(false)
      } finally {
        setIsDeletingTrivia(false)
      }
    }
  }

  const handleEditClick = (trivia: TriviaQuiz) => {
    setTriviaToEdit(trivia)
    setIsEditModalOpen(true)
  }

  const handleUpdateTrivia = async () => {
    // Editing dates can move a quiz between Scheduled/Active/Completed,
    // so refresh stats alongside the list.
    await Promise.all([fetchTrivia(currentPage, false), fetchStatistics()])
    addNotification({
      type: 'success',
      title: 'Trivia Updated',
      message: 'The trivia quiz has been successfully updated.',
    })
  }

  const handleCreateTrivia = async (triviaData: {
    client: string // Client ID from relationship
    question: string
    answers: string[] // Array of answer strings
    correctOptionIndex: number // Index of correct answer
    startDate: string // ISO 8601 datetime string
    endDate: string // ISO 8601 datetime string
    points: number // Points for correct answer
  }) => {
    try {
      setError(null)
      // Map UI form data to DB structure - matching Appwrite schema exactly
      const dbData: Omit<TriviaDocument, keyof Models.Document> = {
        client: triviaData.client || undefined,
        question: triviaData.question,
        answers: triviaData.answers,
        correctOptionIndex: triviaData.correctOptionIndex,
        startDate: triviaData.startDate,
        endDate: triviaData.endDate,
        points: triviaData.points,
      }
      await triviaService.create(dbData)
      setIsCreateModalOpen(false)
      setCurrentPage(1)
      await Promise.all([fetchTrivia(1, false), fetchStatistics()])
      addNotification({
        type: 'success',
        title: 'Trivia Created',
        message: 'The trivia quiz has been successfully created.',
      })
    } catch (err) {
      console.error('Error creating trivia:', err)
      addNotification({
        type: 'error',
        title: 'Create Failed',
        message: 'Failed to create trivia quiz. Please try again.',
      })
    }
  }

  const filteredTrivia = triviaQuizzes

  if (isInitialLoading) {
    return (
      <DashboardLayout>
        <ShimmerPage />
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="p-8">
        <TriviaHeader onCreateNew={() => setIsCreateModalOpen(true)} />
        {statistics && (
          <StatsCards
            stats={[
              {
                label: 'Total Quizzes',
                value: statistics.totalQuizzes.toLocaleString('en-US'),
                icon: 'mdi:format-list-bulleted',
                iconBg: 'bg-green-100',
                iconColor: 'text-green-600',
              },
              {
                label: 'Scheduled',
                value: statistics.scheduled.toLocaleString('en-US'),
                icon: 'mdi:star-four-points',
                iconBg: 'bg-red-100',
                iconColor: 'text-red-600',
              },
              {
                label: 'Active',
                value: statistics.active.toLocaleString('en-US'),
                icon: 'mdi:trending-up',
                iconBg: 'bg-orange-100',
                iconColor: 'text-orange-600',
              },
              {
                label: 'Completed',
                value: statistics.completed.toLocaleString('en-US'),
                icon: 'mdi:trending-up',
                iconBg: 'bg-blue-100',
                iconColor: 'text-blue-600',
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
          onSearchChange={setSearchQuery}
          sortBy={sortBy}
          onSortChange={(sort) => setSortBy(sort as typeof sortBy)}
          sortOrder={sortOrder}
          onSortOrderChange={setSortOrder}
        />
        <TriviaTable
          triviaQuizzes={filteredTrivia}
          searchTerm={searchQuery}
          currentPage={currentPage}
          totalPages={totalPages}
          totalTrivia={totalTrivia}
          pageSize={pageSize}
          onPageChange={handlePageChange}
          onViewClick={(trivia) => navigate(`/trivia/${trivia.id}`)}
          onEditClick={handleEditClick}
          onDeleteClick={handleDeleteClick}
          isLoading={isListLoading}
        />
      </div>

      {/* Create Trivia Modal */}
      <CreateTriviaModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSave={handleCreateTrivia}
      />

      {/* Edit Trivia Modal */}
      {triviaToEdit && (
        <EditTriviaModal
          isOpen={isEditModalOpen}
          onClose={() => {
            setIsEditModalOpen(false)
            setTriviaToEdit(null)
          }}
          triviaId={triviaToEdit.id}
          onUpdate={handleUpdateTrivia}
        />
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false)
          setTriviaToDelete(null)
        }}
        onConfirm={handleConfirmDelete}
        type="delete"
        itemName={
          triviaToDelete?.question
            ? `the trivia "${
                triviaToDelete.question.length > 60
                  ? `${triviaToDelete.question.slice(0, 60)}…`
                  : triviaToDelete.question
              }"`
            : 'trivia quiz'
        }
        isLoading={isDeletingTrivia}
      />
    </DashboardLayout>
  )
}

export default Trivia

