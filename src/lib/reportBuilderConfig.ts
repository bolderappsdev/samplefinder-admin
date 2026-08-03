import type { DropdownOption } from '../components/MultiSelectDropdown'

export type DataSource = 'events' | 'users' | 'clients' | 'reviews' | 'trivia' | 'locations'

export interface ColumnDefinition {
  key: string
  header: string
  category: string
  dataSource: DataSource[]
  format?: 'text' | 'number' | 'date' | 'boolean' | 'currency'
  dependencies?: string[] // Other columns that must be included
}

// All available columns organized by category
export const REPORT_COLUMNS: ColumnDefinition[] = [
  // Event columns
  { key: 'eventName', header: 'Event Name', category: 'Events', dataSource: ['events', 'reviews'] },
  { key: 'eventDate', header: 'Event Date', category: 'Events', dataSource: ['events', 'reviews'], format: 'date' },
  { key: 'startTime', header: 'Start Time', category: 'Events', dataSource: ['events'] },
  { key: 'endTime', header: 'End Time', category: 'Events', dataSource: ['events'] },
  { key: 'checkInCode', header: 'Check-In Code', category: 'Events', dataSource: ['events', 'reviews'] },
  { key: 'checkInPoints', header: 'Check-In Points', category: 'Events', dataSource: ['events'], format: 'number' },
  { key: 'reviewPoints', header: 'Review Points', category: 'Events', dataSource: ['events'], format: 'number' },
  { key: 'eventInfo', header: 'Event Info', category: 'Events', dataSource: ['events'] },
  { key: 'discount', header: 'Discount?', category: 'Events', dataSource: ['events'], format: 'boolean' },
  { key: 'discountText', header: 'Discount Text', category: 'Events', dataSource: ['events'] },
  { key: 'discountImageFile', header: 'Discount Image File?', category: 'Events', dataSource: ['events'], format: 'boolean' },
  
  // Location columns
  { key: 'location', header: 'Location', category: 'Location', dataSource: ['events', 'locations'] },
  { key: 'address', header: 'Address', category: 'Location', dataSource: ['events', 'locations'] },
  { key: 'city', header: 'City', category: 'Location', dataSource: ['events', 'locations'] },
  { key: 'state', header: 'State', category: 'Location', dataSource: ['events', 'locations'] },
  { key: 'zip', header: 'Zip Code', category: 'Location', dataSource: ['events', 'locations'] },
  { key: 'timeZone', header: 'Time Zone', category: 'Location', dataSource: ['events'] },
  
  // Client/Brand columns
  { key: 'clientName', header: 'Client Name', category: 'Clients', dataSource: ['events', 'clients', 'reviews'] },
  { key: 'logoFile', header: 'Client Logo File?', category: 'Clients', dataSource: ['clients'], format: 'boolean' },
  { key: 'productType', header: 'Product Type', category: 'Clients', dataSource: ['events', 'reviews'] },
  { key: 'products', header: 'Products', category: 'Clients', dataSource: ['events', 'clients'] },
  { key: 'favorites', header: '# of Favorites', category: 'Clients', dataSource: ['clients'], format: 'number' },
  
  // User columns
  { key: 'firstName', header: 'First Name', category: 'Users', dataSource: ['users', 'reviews'] },
  { key: 'lastName', header: 'Last Name', category: 'Users', dataSource: ['users', 'reviews'] },
  { key: 'username', header: 'Username', category: 'Users', dataSource: ['users', 'reviews'] },
  { key: 'email', header: 'Email', category: 'Users', dataSource: ['users', 'reviews'] },
  { key: 'phoneNumber', header: 'Phone Number', category: 'Users', dataSource: ['users'] },
  { key: 'dob', header: 'DOB', category: 'Users', dataSource: ['users'], format: 'date' },
  { key: 'signUpDate', header: 'Sign-Up Date', category: 'Users', dataSource: ['users', 'clients'], format: 'date' },
  { key: 'lastLoginDate', header: 'Last Login Date', category: 'Users', dataSource: ['users'], format: 'date' },
  { key: 'referralCode', header: 'Referral Code', category: 'Users', dataSource: ['users'] },
  { key: 'referralsCount', header: '# of Referrals', category: 'Users', dataSource: ['users'], format: 'number' },
  { key: 'userPoints', header: 'User Points', category: 'Users', dataSource: ['users'], format: 'number' },
  { key: 'checkInReviewPoints', header: 'Check-in/Review Pts', category: 'Users', dataSource: ['users'], format: 'number' },
  { key: 'baBadge', header: 'BA Badge (Yes/No)', category: 'Users', dataSource: ['users'], format: 'boolean' },
  { key: 'influencerBadge', header: 'Influencer Badge (Yes/No)', category: 'Users', dataSource: ['users'], format: 'boolean' },
  { key: 'tierLevel', header: 'Tier Level', category: 'Users', dataSource: ['users'] },
  { key: 'checkIns', header: 'Check-Ins', category: 'Users', dataSource: ['users'], format: 'number' },
  { key: 'reviews', header: 'Reviews', category: 'Users', dataSource: ['users'], format: 'number' },
  { key: 'triviasWon', header: 'Trivias Won', category: 'Users', dataSource: ['users'], format: 'number' },
  // Referral bonuses have two sides. 'referralsCount'/'User Points' above never showed the inviter's
  // half, so someone whose points came mostly from referring others read as having earned nothing.
  // These two are range-scoped when a date range is set (see USER_RANGE_COLUMN_HEADERS).
  { key: 'referrerPoints', header: 'Referral Pts — Invited', category: 'Users', dataSource: ['users'], format: 'number' },
  { key: 'referralsMade', header: 'Referrals Made', category: 'Users', dataSource: ['users'], format: 'number' },
  // Always lifetime, even on a range report — pair them with User Points to see, per user, how much
  // of a lifetime total the selected window explains and how much has no datable source at all.
  { key: 'lifetimePoints', header: 'Lifetime Points', category: 'Users', dataSource: ['users'], format: 'number' },
  { key: 'unattributedPoints', header: 'Unattributed Points', category: 'Users', dataSource: ['users'], format: 'number' },

  // Review columns
  { key: 'checkIn', header: 'Check-In (Yes/No)', category: 'Reviews', dataSource: ['reviews'], format: 'boolean' },
  { key: 'hasReview', header: 'Review (Yes/No)', category: 'Reviews', dataSource: ['reviews'], format: 'boolean' },
  { key: 'reviewStars', header: 'Review: # of Stars', category: 'Reviews', dataSource: ['reviews'], format: 'number' },
  { key: 'reviewLiked', header: 'Review: What did they like', category: 'Reviews', dataSource: ['reviews'] },
  { key: 'reviewPurchased', header: 'Review: Did they buy (Yes/No)', category: 'Reviews', dataSource: ['reviews'], format: 'boolean' },
  { key: 'reviewFeedback', header: 'Review: Feedback Detail Text', category: 'Reviews', dataSource: ['reviews'] },
  { key: 'reviewedAt', header: 'Reviewed At', category: 'Reviews', dataSource: ['reviews'], format: 'date' },
  { key: 'pointsEarned', header: 'Points Earned', category: 'Reviews', dataSource: ['reviews'], format: 'number' },
  
  // Trivia columns
  { key: 'triviaDate', header: 'Trivia Date', category: 'Trivia', dataSource: ['trivia'], format: 'date' },
  { key: 'question', header: 'Trivia Question', category: 'Trivia', dataSource: ['trivia'] },
  { key: 'answer1', header: 'Trivia Answer 1', category: 'Trivia', dataSource: ['trivia'] },
  { key: 'answer2', header: 'Trivia Answer 2', category: 'Trivia', dataSource: ['trivia'] },
  { key: 'answer3', header: 'Trivia Answer 3', category: 'Trivia', dataSource: ['trivia'] },
  { key: 'answer4', header: 'Trivia Answer 4', category: 'Trivia', dataSource: ['trivia'] },
  { key: 'totalResponses', header: 'Total Responses', category: 'Trivia', dataSource: ['trivia'], format: 'number' },
  { key: 'totalCorrect', header: 'Total Correct Responses', category: 'Trivia', dataSource: ['trivia'], format: 'number' },
  { key: 'answer1Count', header: 'Answer 1 # Responses', category: 'Trivia', dataSource: ['trivia'], format: 'number' },
  { key: 'answer2Count', header: 'Answer 2 # Responses', category: 'Trivia', dataSource: ['trivia'], format: 'number' },
  { key: 'answer3Count', header: 'Answer 3 # Responses', category: 'Trivia', dataSource: ['trivia'], format: 'number' },
  { key: 'answer4Count', header: 'Answer 4 # Responses', category: 'Trivia', dataSource: ['trivia'], format: 'number' },
  { key: 'answer1Percent', header: 'Answer 1 % Responses', category: 'Trivia', dataSource: ['trivia'] },
  { key: 'answer2Percent', header: 'Answer 2 % Responses', category: 'Trivia', dataSource: ['trivia'] },
  { key: 'answer3Percent', header: 'Answer 3 % Responses', category: 'Trivia', dataSource: ['trivia'] },
  { key: 'answer4Percent', header: 'Answer 4 % Responses', category: 'Trivia', dataSource: ['trivia'] },
  { key: 'totalPointsAwarded', header: 'Total Points Awarded', category: 'Trivia', dataSource: ['trivia'], format: 'number' },
]

// Convert to dropdown options
export const getColumnOptions = (dataSource?: DataSource): DropdownOption[] => {
  const columns = dataSource 
    ? REPORT_COLUMNS.filter(col => col.dataSource.includes(dataSource))
    : REPORT_COLUMNS
  
  return columns.map(col => ({
    value: col.key,
    label: col.header,
    category: col.category,
  }))
}

// Get columns by keys
export const getColumnsByKeys = (keys: string[]): ColumnDefinition[] => {
  return REPORT_COLUMNS.filter(col => keys.includes(col.key))
}

// Get required data sources for selected columns
export const getRequiredDataSources = (columnKeys: string[]): DataSource[] => {
  const sources = new Set<DataSource>()
  const columns = getColumnsByKeys(columnKeys)
  
  columns.forEach(col => {
    col.dataSource.forEach(source => sources.add(source))
  })
  
  return Array.from(sources)
}

// Entity configurations
export const ENTITY_OPTIONS = [
  { value: 'events', label: 'Events', description: 'Event data including locations and schedules' },
  { value: 'users', label: 'Users', description: 'User profiles and statistics' },
  { value: 'clients', label: 'Clients & Brands', description: 'Client and brand information' },
  { value: 'reviews', label: 'Reviews', description: 'Event reviews and check-ins' },
  { value: 'trivia', label: 'Trivia', description: 'Trivia questions and responses' },
  { value: 'all', label: 'All Data', description: 'Combined data from all sources' },
] as const

export type EntityType = typeof ENTITY_OPTIONS[number]['value']