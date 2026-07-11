import { useState, useEffect } from 'react'
import { Icon } from '@iconify/react'

interface SearchAndFilterProps {
  searchTerm: string
  onSearchChange: (term: string) => void
  sortBy: string
  onSortByChange: (value: string) => void
  sortOrder: 'asc' | 'desc'
  onSortOrderChange: (order: 'asc' | 'desc') => void
}

const SearchAndFilter = ({
  searchTerm,
  onSearchChange,
  sortBy,
  onSortByChange,
  sortOrder,
  onSortOrderChange,
}: SearchAndFilterProps) => {
  // Debounce the search input so each keystroke doesn't drive a full-collection searchAll fetch.
  const [localSearchTerm, setLocalSearchTerm] = useState(searchTerm)
  useEffect(() => {
    const timer = setTimeout(() => onSearchChange(localSearchTerm), 300)
    return () => clearTimeout(timer)
  }, [localSearchTerm, onSearchChange])
  useEffect(() => {
    setLocalSearchTerm(searchTerm)
  }, [searchTerm])
  const getSortDisplayText = () => {
    const sortLabels: Record<string, string> = {
      createdAt: 'Created Date',
      title: 'Category Title',
    }
    return sortLabels[sortBy] || 'Created Date'
  }
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Icon icon="mdi:filter" className="w-5 h-5 text-gray-600" />
        <h2 className="text-lg font-semibold text-gray-900">Search & Filter</h2>
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex-1 relative">
          <Icon
            icon="mdi:magnify"
            className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400"
          />
          <input
            type="text"
            placeholder="Search by category title..."
            value={localSearchTerm}
            onChange={(e) => setLocalSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
          />
        </div>
        <select
          value={sortBy}
          onChange={(e) => onSortByChange(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
        >
          <option value="createdAt">Sort by: Created Date</option>
          <option value="title">Sort by: Category Title</option>
        </select>
        <button
          onClick={() => onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc')}
          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700"
          title={`Sort ${sortOrder === 'asc' ? 'Ascending' : 'Descending'}`}
        >
          <Icon
            icon={sortOrder === 'asc' ? 'mdi:arrow-up' : 'mdi:arrow-down'}
            className="w-5 h-5"
          />
          {getSortDisplayText()}
        </button>
      </div>
    </div>
  )
}

export default SearchAndFilter

