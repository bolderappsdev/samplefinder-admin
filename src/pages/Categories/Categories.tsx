import { useState, useEffect, useRef } from 'react'
import { DashboardLayout, ConfirmationModal } from '../../components'
import {
  CategoriesHeader,
  SummaryCards,
  SearchAndFilter,
  CategoriesTable,
  AddCategoryModal,
  EditCategoryModal,
} from './components'
import { categoriesService, type CategoryDocument } from '../../lib/services'
import { useNotificationStore } from '../../stores/notificationStore'
import { useTimezoneStore } from '../../stores/timezoneStore'
import { formatDateInAppTimezone } from '../../lib/dateUtils'
import { Query } from '../../lib/appwrite'

// UI Category interface (for display and table)
interface UICategory {
  id?: string
  title: string
  isAdult?: boolean
  createdAt?: string
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

const Categories = () => {
  const { addNotification } = useNotificationStore()
  const { appTimezone } = useTimezoneStore()
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<UICategory | null>(null)
  const [categoryToDelete, setCategoryToDelete] = useState<UICategory | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')

  // Transform CategoryDocument to UICategory for display
  const transformToUICategory = (doc: CategoryDocument): UICategory => {
    return {
      id: doc.$id,
      title: doc.title || '',
      isAdult: doc.isAdult ?? false,
      createdAt: doc.$createdAt ? formatDateInAppTimezone(doc.$createdAt, appTimezone, 'short') : undefined,
    }
  }

  const [categories, setCategories] = useState<UICategory[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalCategories, setTotalCategories] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [newThisMonthCount, setNewThisMonthCount] = useState(0)
  const [sortBy, setSortBy] = useState<'createdAt' | 'title'>('createdAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  // Only the latest fetch may commit — search now pages the full set (multiple round-trips), so a
  // slower earlier fetch could otherwise resolve after a newer one and overwrite it.
  const fetchIdRef = useRef(0)

  // Count categories created this month directly from the DB so the
  // summary card stays accurate regardless of which page is currently
  // loaded into the table.
  const fetchCategoryStats = async () => {
    try {
      const now = new Date()
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      const result = await categoriesService.list([
        Query.greaterThanEqual('$createdAt', startOfMonth.toISOString()),
        Query.limit(1),
      ])
      setNewThisMonthCount(result.total)
    } catch (err) {
      console.error('Error fetching category stats:', err)
    }
  }

  // Fetch categories from Appwrite with pagination and sorting
  const fetchCategories = async (page: number = currentPage) => {
    const thisFetchId = ++fetchIdRef.current
    try {
      setIsLoading(true)
      setError(null)
      
      // Build sort order (both sort fields are server-orderable)
      const orderMethod = sortOrder === 'asc' ? Query.orderAsc : Query.orderDesc
      const orderQuery = sortBy === 'title' ? orderMethod('title') : orderMethod('$createdAt')
      const trimmedSearch = searchTerm.trim()
      const isSearching = trimmedSearch.length > 0

      // Searching filters client-side, so it must see the FULL collection (searchAll pages through
      // everything) — not just the current page, which would hide matches on later pages. Browsing
      // keeps efficient server-side pagination.
      let result: { documents: CategoryDocument[]; total: number }
      if (isSearching) {
        result = await categoriesService.searchAll(trimmedSearch, [orderQuery])
      } else {
        result = await categoriesService.list([
          orderQuery,
          Query.limit(pageSize),
          Query.offset((page - 1) * pageSize),
        ])
      }

      // Discard this result if a newer fetch has started (avoids stale overwrite).
      if (thisFetchId !== fetchIdRef.current) return

      // Extract pagination metadata
      const total = result.total
      const totalPagesCount = Math.ceil(total / pageSize)
      setTotalCategories(total)
      setTotalPages(totalPagesCount)

      // Handle edge case: if current page exceeds total pages, reset to last valid page or page 1
      if (totalPagesCount > 0 && page > totalPagesCount) {
        const lastValidPage = totalPagesCount
        setCurrentPage(lastValidPage)
        if (page !== lastValidPage) {
          return fetchCategories(lastValidPage)
        }
      } else if (totalPagesCount === 0) {
        setCurrentPage(1)
      }

      // Search returns the full matched set — paginate it client-side; browsing is already one page.
      const pageDocuments = isSearching
        ? result.documents.slice((page - 1) * pageSize, page * pageSize)
        : result.documents
      const transformedCategories = pageDocuments.map(transformToUICategory)
      setCategories(transformedCategories)
      setCurrentPage(page)
    } catch (err) {
      console.error('Error fetching categories:', err)
      setError('Failed to load categories. Please try again.')
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to load categories. Please try again.',
      })
    } finally {
      if (thisFetchId === fetchIdRef.current) {
        setIsLoading(false)
      }
    }
  }

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      fetchCategories(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // Reset to page 1 when search or sort changes
  useEffect(() => {
    setCurrentPage(1)
    fetchCategories(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, sortBy, sortOrder])

  // Initial stats load (totalCategories is refreshed by fetchCategories)
  useEffect(() => {
    fetchCategoryStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const summaryCards = [
    {
      label: 'Total Categories',
      value: totalCategories.toString(),
      icon: 'mdi:tag-multiple',
      iconBg: 'bg-blue-100',
      iconColor: 'text-blue-600',
    },
    {
      label: 'New This Month',
      value: newThisMonthCount.toString(),
      icon: 'mdi:chart-line',
      iconBg: 'bg-green-100',
      iconColor: 'text-green-600',
    },
  ]

  const handleEditClick = (category: UICategory) => {
    setSelectedCategory(category)
    setIsEditModalOpen(true)
  }

  const handleDeleteClick = (category: UICategory) => {
    setCategoryToDelete(category)
    setIsDeleteModalOpen(true)
  }

  const handleConfirmDelete = async () => {
    if (categoryToDelete?.id) {
      try {
        await categoriesService.delete(categoryToDelete.id)
        // Check if we need to go back a page if current page becomes empty
        if (categories.length === 1 && currentPage > 1) {
          setCurrentPage(currentPage - 1)
          await Promise.all([fetchCategories(currentPage - 1), fetchCategoryStats()])
        } else {
          await Promise.all([fetchCategories(currentPage), fetchCategoryStats()])
        }
        setIsDeleteModalOpen(false)
        setCategoryToDelete(null)
        addNotification({
          type: 'success',
          title: 'Category Deleted',
          message: 'The category has been successfully deleted.',
        })
      } catch (err) {
        console.error('Error deleting category:', err)
        const errorMessage = extractErrorMessage(err)
        addNotification({
          type: 'error',
          title: 'Failed to Delete Category',
          message: errorMessage,
        })
      }
    }
  }

  const handleCreateCategory = async (categoryData: { title: string; isAdult?: boolean }) => {
    try {
      // Backup duplicate check
      const existingCategory = await categoriesService.findByTitle(categoryData.title.trim())
      if (existingCategory) {
        const errorMessage = 'A category with this title already exists. Please use a different title.'
        addNotification({
          type: 'error',
          title: 'Failed to Create Category',
          message: errorMessage,
        })
        throw new Error(errorMessage)
      }

      await categoriesService.create(categoryData)
      setCurrentPage(1)
      await Promise.all([fetchCategories(1), fetchCategoryStats()])
      
      // Show success notification
      addNotification({
        type: 'success',
        title: 'Category Created',
        message: 'The category has been successfully created.',
      })
      
      setIsModalOpen(false)
    } catch (err) {
      console.error('Error creating category:', err)
      
      // Extract error message from Appwrite error
      const errorMessage = extractErrorMessage(err)
      
      // Show error notification with actual error message
      addNotification({
        type: 'error',
        title: 'Failed to Create Category',
        message: errorMessage,
      })
      
      // Re-throw error so modal can handle it (keep modal open)
      throw err
    }
  }

  const handleUpdateCategory = async (categoryData: { title: string; isAdult?: boolean }) => {
    if (!selectedCategory?.id) return

    try {
      // Backup duplicate check (excluding current category)
      const existingCategory = await categoriesService.findByTitle(categoryData.title.trim())
      if (existingCategory && existingCategory.$id !== selectedCategory.id) {
        const errorMessage = 'A category with this title already exists. Please use a different title.'
        addNotification({
          type: 'error',
          title: 'Failed to Update Category',
          message: errorMessage,
        })
        throw new Error(errorMessage)
      }

      await categoriesService.update(selectedCategory.id, categoryData)
      await fetchCategories(currentPage) // Refresh list - keep current page
      setIsEditModalOpen(false)
      setSelectedCategory(null)
      addNotification({
        type: 'success',
        title: 'Category Updated',
        message: 'The category has been successfully updated.',
      })
    } catch (err) {
      console.error('Error updating category:', err)
      const errorMessage = extractErrorMessage(err)
      addNotification({
        type: 'error',
        title: 'Failed to Update Category',
        message: errorMessage,
      })
      throw err
    }
  }

  return (
    <DashboardLayout>
      <div className="p-8">
        <CategoriesHeader onAddCategory={() => setIsModalOpen(true)} />
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
          onSearchChange={setSearchTerm}
          sortBy={sortBy}
          onSortByChange={(value) => setSortBy(value as typeof sortBy)}
          sortOrder={sortOrder}
          onSortOrderChange={setSortOrder}
        />
        <CategoriesTable
          searchTerm={searchTerm}
          categories={categories}
          isLoading={isLoading}
          currentPage={currentPage}
          totalPages={totalPages}
          totalCategories={totalCategories}
          pageSize={pageSize}
          onPageChange={handlePageChange}
          onEditClick={handleEditClick}
          onDeleteClick={handleDeleteClick}
        />
      </div>

      {/* Add Category Modal */}
      <AddCategoryModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleCreateCategory}
      />

      {/* Edit Category Modal */}
      <EditCategoryModal
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false)
          setSelectedCategory(null)
        }}
        onSave={handleUpdateCategory}
        initialData={
          selectedCategory
            ? {
                title: selectedCategory.title,
                isAdult: selectedCategory.isAdult ?? false,
              }
            : undefined
        }
        categoryId={selectedCategory?.id}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false)
          setCategoryToDelete(null)
        }}
        onConfirm={handleConfirmDelete}
        type="delete"
        itemName={categoryToDelete ? `category "${categoryToDelete.title}"` : 'category'}
      />
    </DashboardLayout>
  )
}

export default Categories

