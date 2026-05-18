import { Icon } from '@iconify/react'
import { Pagination, TableEmptyState, TableLoadingState } from '../../../components'

interface User {
  $id?: string
  authID?: string
  firstName?: string
  lastName?: string
  username?: string
  phoneNumber?: string
  email?: string
  role?: string
  tierLevel?: string
  totalPoints?: number
  $createdAt?: string
  isBlocked?: boolean
  dob?: string
  totalEvents?: number
  totalReviews?: number
}

interface UsersTableProps {
  users: User[]
  onEditClick: (user: User) => void
  onDeleteClick: (user: User) => void
  currentPage?: number
  totalPages?: number
  totalUsers?: number
  pageSize?: number
  onPageChange?: (page: number) => void
  isLoading?: boolean
  searchTerm?: string
  hasFilters?: boolean
}

const UsersTable = ({
  users,
  onEditClick,
  onDeleteClick,
  currentPage = 1,
  totalPages = 0,
  totalUsers = 0,
  pageSize = 25,
  onPageChange,
  isLoading = false,
  searchTerm = '',
  hasFilters = false,
}: UsersTableProps) => {
  const isFiltered = searchTerm.trim().length > 0 || hasFilters
  // DOB column is rendered MM/DD/YYYY by manual string construction so the format is
  // locale-proof (browsers like en-GB would otherwise produce DD/MM/YYYY from toLocaleDateString)
  // and timezone-proof: we use the ISO date prefix or UTC components so UTC midnight does not
  // roll back to the previous day in negative-offset zones.
  const formatDateOnly = (dateStr: string | undefined): string => {
    if (!dateStr) return '-'
    const match = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
    if (match) {
      const [, y, m, d] = match
      return `${m!.padStart(2, '0')}/${d!.padStart(2, '0')}/${y}`
    }
    const dt = new Date(dateStr)
    if (isNaN(dt.getTime())) return '-'
    const y = dt.getUTCFullYear()
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const d = String(dt.getUTCDate()).padStart(2, '0')
    return `${m}/${d}/${y}`
  }

  // Format phone number to (XXX) XXX-XXXX
  const formatPhoneNumber = (phoneNumber: string | undefined) => {
    if (!phoneNumber) return '-'
    
    // Remove all non-digits
    const cleaned = phoneNumber.replace(/\D/g, '')
    
    // Format based on length
    if (cleaned.length === 10) {
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`
    }
    
    // Return as-is if not 10 digits
    return phoneNumber
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  First Name
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  Last Name
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  Username
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  Phone Number
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  Email
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  Tier Level
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  Total Points
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  Date of Birth
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  Check Ins
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <Icon icon="mdi:filter" className="w-4 h-4" />
                  Reviews
                </div>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {isLoading ? (
              <TableLoadingState colSpan={11} />
            ) : users.length === 0 ? (
              isFiltered ? (
                <TableEmptyState
                  colSpan={11}
                  icon="mdi:magnify"
                  title="No results found"
                  description="Try adjusting your search or filters."
                />
              ) : (
                <TableEmptyState
                  colSpan={11}
                  icon="mdi:account-multiple-outline"
                  title="No users yet"
                  description="App users will appear here once they sign up."
                />
              )
            ) : (
              users.map((user) => (
                <tr 
                  key={user.$id || user.authID} 
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                  onClick={() => onEditClick(user)}
                >
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.firstName || '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.lastName || '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.username || '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatPhoneNumber(user.phoneNumber)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.email || '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.tierLevel || '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.totalPoints?.toLocaleString() || '0'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatDateOnly(user.dob)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.totalEvents?.toLocaleString() || '0'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {user.totalReviews?.toLocaleString() || '0'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onEditClick(user)
                        }}
                        className="hover:text-blue-600 transition-colors"
                        title="Edit user"
                      >
                        <Icon icon="mdi:pencil" className="w-5 h-5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onDeleteClick(user)
                        }}
                        className="hover:text-red-600 transition-colors"
                        title="Delete user"
                      >
                        <Icon icon="mdi:trash-can" className="w-5 h-5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {/* Pagination */}
      {onPageChange && totalPages > 0 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalUsers}
          pageSize={pageSize}
          itemLabel="users"
          onPageChange={onPageChange}
        />
      )}
    </div>
  )
}

export default UsersTable

