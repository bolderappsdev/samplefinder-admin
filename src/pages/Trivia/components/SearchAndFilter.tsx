import { useState, useEffect } from 'react'
import { Icon } from '@iconify/react'

interface SearchAndFilterProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  sortBy: string
  onSortChange: (sort: string) => void
  sortOrder: 'asc' | 'desc'
  onSortOrderChange: (order: 'asc' | 'desc') => void
}

const SearchAndFilter = ({
  searchQuery,
  onSearchChange,
  sortBy,
  onSortChange,
  sortOrder,
  onSortOrderChange,
}: SearchAndFilterProps) => {
  // Debounce the search input: each keystroke now drives a full-collection fetch, so committing on
  // every character would sweep the whole trivia collection repeatedly. Commit 300ms after typing stops.
  const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery)
  useEffect(() => {
    const timer = setTimeout(() => onSearchChange(localSearchQuery), 300)
    return () => clearTimeout(timer)
  }, [localSearchQuery, onSearchChange])
  // Keep the input in sync when the query is changed/cleared from outside.
  useEffect(() => {
    setLocalSearchQuery(searchQuery)
  }, [searchQuery])
  const getSortDisplayText = () => {
    const sortLabels: Record<string, string> = {
      date: 'Date',
      name: 'Name',
      status: 'Status',
      responses: 'Responses',
      view: 'View',
      skip: 'Skip',
      incorrect: 'Incorrect',
      winners: 'Winners',
    }
    return `Sort by: ${sortLabels[sortBy] || 'Date'}`
  }
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Icon icon="mdi:filter" className="w-5 h-5 text-gray-600" />
        <h2 className="text-lg font-semibold text-gray-900">Search & Filter</h2>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 relative">
          <Icon
            icon="mdi:magnify"
            className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400"
          />
          <input
            type="text"
            placeholder="Search by question"
            value={localSearchQuery}
            onChange={(e) => setLocalSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Sort by:</label>
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
          >
            <option value="date">Date</option>
            <option value="name">Name</option>
            <option value="status">Status</option>
            <option value="responses">Responses</option>
            <option value="view">View</option>
            <option value="skip">Skip</option>
            <option value="incorrect">Incorrect</option>
            <option value="winners">Winners</option>
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
    </div>
  )
}

export default SearchAndFilter

