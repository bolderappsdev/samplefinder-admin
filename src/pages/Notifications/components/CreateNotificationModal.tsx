import { useState, useEffect, useRef } from 'react'
import { Icon } from '@iconify/react'
import type { NotificationFormData, AppUser, NotificationAudience } from '../../../lib/services'
import { trimFormStrings } from '../../../lib/formUtils'
import { appUsersService, locationsService } from '../../../lib/services'
import { useUnsavedChanges } from '../../../hooks/useUnsavedChanges'
import { UnsavedChangesModal } from '../../../components'
import { appTimeToUTC, DEFAULT_APP_TIMEZONE, getTodayDateStringInTimezone } from '../../../lib/dateUtils'
import { matchesAllTokens } from '../../../lib/userSearch'

interface CreateNotificationModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (notificationData: NotificationFormData) => void
  initialData?: NotificationFormData | null
  isEditMode?: boolean
  /** IANA timezone for scheduled date/time validation and display */
  appTimezone?: string
}

interface ValidationErrors {
  title?: string
  message?: string
  scheduledAt?: string
  scheduledTime?: string
  selectedUserIds?: string
}

type ValidationErrorCode =
  | 'REQUIRED_FIELD'
  | 'MIN_LENGTH'
  | 'MAX_LENGTH'
  | 'INVALID_DATE'
  | 'PAST_DATE'
  | 'USERS_REQUIRED'

interface StructuredError {
  code: ValidationErrorCode
  field: string
  fieldName: string // The actual field key (e.g., 'title', 'message')
  message: string
}

function createEmptyNotificationForm(): NotificationFormData {
  return {
    title: '',
    message: '',
    type: 'Notification', // use 'Notification' as in the HEAD
    targetAudience: 'All',
    category: 'AppPush',
    schedule: 'Send Immediately',
    scheduledAt: '',
    scheduledTime: '13:00', // use '13:00' as default scheduledTime
    selectedUserIds: [],
    selectedZipCodes: [],
    newUsersTimeRange: undefined,
  }
}

interface NotificationTemplate {
  id: string
  label: string
  title: string
  body: string
  autoAudience?: NotificationAudience
}

const APP_PUSH_TEMPLATES: NotificationTemplate[] = [
  { id: '', label: 'No template', title: '', body: '' },
  { id: 'monthly_winner_first', label: 'Monthly Winner: First Place', title: 'MONTHLY WINNER: FIRST PLACE!', body: 'Congratulations, you scored the most points of all SampleFinder users this month! Our team will be in touch with prize details!' },
  { id: 'monthly_winner_second', label: 'Monthly Winner: Second Place', title: 'MONTHLY WINNER: SECOND PLACE!', body: 'Congratulations, you scored the most points of all SampleFinder check-ins and reviews this month! Our team will be in touch with prize details!' },
  { id: 'monthly_winner_promo_loot', label: 'Monthly Winner: Promo Loot Crate', title: 'MONTHLY WINNER: PROMO LOOT CRATE!', body: "Congratulations, you're the lucky winner of our promo loot crate! Our team will be in touch with prize details!" },
]

// Push notification limits (single max per field for admin UI and validation)
const VALIDATION_RULES = {
  title: {
    minLength: 3,
    maxLength: 50,
  },
  message: {
    minLength: 3,
    maxLength: 150,
  },
}

const CreateNotificationModal = ({
  isOpen,
  onClose,
  onSave,
  initialData,
  isEditMode = false,
}: CreateNotificationModalProps) => {
  const [formData, setFormData] = useState<NotificationFormData>(() => createEmptyNotificationForm())
  const initialDataRef = useRef<NotificationFormData>(createEmptyNotificationForm())
  const [showUnsavedChangesModal, setShowUnsavedChangesModal] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({})
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set())
  const [selectedAppTemplateId, setSelectedAppTemplateId] = useState<string>('')
  const [users, setUsers] = useState<AppUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [showUserDropdown, setShowUserDropdown] = useState(false)
  const [availableZipCodes, setAvailableZipCodes] = useState<string[]>([])
  const [isLoadingZipCodes, setIsLoadingZipCodes] = useState(false)
  
  const hasUnsavedChanges = useUnsavedChanges(formData as unknown as Record<string, unknown>, initialDataRef.current as unknown as Record<string, unknown>, isOpen)
  // Scheduled notifications are pinned to 1:00 PM Eastern regardless of app timezone.
  const scheduleTimezone = DEFAULT_APP_TIMEZONE
  const minScheduledDate = getTodayDateStringInTimezone(scheduleTimezone)

  // Fetch users when modal opens
  useEffect(() => {
    const fetchUsers = async () => {
      setLoadingUsers(true)
      try {
        const usersList = await appUsersService.listAll()
        setUsers(usersList)
      } catch (error) {
        console.error('Error fetching users:', error)
      } finally {
        setLoadingUsers(false)
      }
    }

    if (isOpen) {
      fetchUsers()
    }
  }, [isOpen])

  // Fetch distinct zip codes when modal opens (for ZipCode audience)
  useEffect(() => {
    const fetchZipCodes = async () => {
      setIsLoadingZipCodes(true)
      try {
        const locations = await locationsService.list()
        const zips = Array.from(
          new Set(
            (locations.documents || [])
              .map((loc) => (loc as { zipCode?: string }).zipCode)
              .filter((z): z is string => !!z)
          )
        ).sort()
        setAvailableZipCodes(zips)
      } catch (error) {
        console.error('Error fetching zip codes:', error)
      } finally {
        setIsLoadingZipCodes(false)
      }
    }

    if (isOpen) {
      void fetchZipCodes()
    }
  }, [isOpen])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (showUserDropdown && !target.closest('.user-dropdown-container')) {
        setShowUserDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showUserDropdown])

  // Update form data when initialData changes (for edit mode)
  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setFormData(initialData)
        initialDataRef.current = initialData
      } else {
        const empty = createEmptyNotificationForm()
        setFormData(empty)
        initialDataRef.current = empty
      }
      setValidationErrors({})
      setTouchedFields(new Set())
      setSelectedAppTemplateId('')
      setUserSearchQuery('')
      setShowUserDropdown(false)
    }
  }, [initialData, isOpen])

  if (!isOpen) return null

  // Validation helper function
  const getErrorMessage = (error: StructuredError): string => {
    const errorMessages: Record<ValidationErrorCode, (field: string, rules?: any) => string> = {
      REQUIRED_FIELD: (field) => `${field} is required`,
      MIN_LENGTH: (field, rules) => `${field} must be at least ${rules.minLength} characters`,
      MAX_LENGTH: (field, rules) => `${field} must not exceed ${rules.maxLength} characters`,
      INVALID_DATE: () => 'Please select a date',
      PAST_DATE: () => 'Scheduled date and time must be in the future',
      USERS_REQUIRED: () => 'Please select at least one user',
    }
    return errorMessages[error.code](error.field, VALIDATION_RULES[error.fieldName as keyof typeof VALIDATION_RULES])
  }

  // Validate individual field
  const validateField = (field: string, value: string): StructuredError | null => {
    // Title validation
    if (field === 'title') {
      if (!value.trim()) {
        return { code: 'REQUIRED_FIELD', field: 'Notification Title', fieldName: 'title', message: '' }
      }
      if (value.trim().length < VALIDATION_RULES.title.minLength) {
        return { code: 'MIN_LENGTH', field: 'Notification Title', fieldName: 'title', message: '' }
      }
      if (value.length > VALIDATION_RULES.title.maxLength) {
        return { code: 'MAX_LENGTH', field: 'Notification Title', fieldName: 'title', message: '' }
      }
    }

    // Message validation
    if (field === 'message') {
      if (!value.trim()) {
        return { code: 'REQUIRED_FIELD', field: 'Message', fieldName: 'message', message: '' }
      }
      if (value.trim().length < VALIDATION_RULES.message.minLength) {
        return { code: 'MIN_LENGTH', field: 'Message', fieldName: 'message', message: '' }
      }
      if (value.length > VALIDATION_RULES.message.maxLength) {
        return { code: 'MAX_LENGTH', field: 'Message', fieldName: 'message', message: '' }
      }
    }

    // Schedule validation
    if (formData.schedule === 'Schedule for Later') {
      if (field === 'scheduledAt' && !value) {
        return { code: 'REQUIRED_FIELD', field: 'Scheduled Date', fieldName: 'scheduledAt', message: '' }
      }
      if (field === 'scheduledTime') return null
    }

    return null
  }

  // Validate entire form (optionally against provided data, e.g. trimmed form data)
  const validateForm = (dataToValidate?: NotificationFormData): { isValid: boolean; errors: StructuredError[] } => {
    const data = dataToValidate ?? formData
    const errors: StructuredError[] = []
    const newValidationErrors: ValidationErrors = {}

    // Validate title
    const titleError = validateField('title', data.title)
    if (titleError) {
      errors.push(titleError)
      newValidationErrors.title = getErrorMessage(titleError)
    }

    // Validate message
    const messageError = validateField('message', data.message)
    if (messageError) {
      errors.push(messageError)
      newValidationErrors.message = getErrorMessage(messageError)
    }

    // Validate scheduled date/time if scheduling for later
    if (data.schedule === 'Schedule for Later') {
      if (!data.scheduledAt) {
        const error: StructuredError = { 
          code: 'INVALID_DATE', 
          field: 'Scheduled Date/Time',
          fieldName: 'scheduledAt',
          message: '' 
        }
        errors.push(error)
        newValidationErrors.scheduledAt = getErrorMessage(error)
      } else {
        // Same interpretation as notificationsService.create (1:00 PM in app timezone)
        const scheduledDate = appTimeToUTC(data.scheduledAt, '13:00', scheduleTimezone)
        if (scheduledDate <= new Date()) {
          const error: StructuredError = { 
            code: 'PAST_DATE', 
            field: 'Scheduled Date/Time',
            fieldName: 'scheduledTime',
            message: '' 
          }
          errors.push(error)
          newValidationErrors.scheduledTime = getErrorMessage(error)
        }
      }
    }

    // Validate selected users when targeting specific users
    if (data.targetAudience === 'Targeted' && (!data.selectedUserIds || data.selectedUserIds.length === 0)) {
      const error: StructuredError = {
        code: 'USERS_REQUIRED',
        field: 'Selected Users',
        fieldName: 'selectedUserIds',
        message: ''
      }
      errors.push(error)
      newValidationErrors.selectedUserIds = getErrorMessage(error)
    }

    setValidationErrors(newValidationErrors)
    return { isValid: errors.length === 0, errors }
  }

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    
    // Real-time validation for touched fields
    if (touchedFields.has(field)) {
      const error = validateField(field, value)
      setValidationErrors((prev) => ({
        ...prev,
        [field]: error ? getErrorMessage(error) : undefined,
      }))
      
      // Also revalidate schedule fields when schedule type changes
      if (field === 'schedule') {
        setValidationErrors((prev) => ({
          ...prev,
          scheduledAt: undefined,
          scheduledTime: undefined,
        }))
      }

      // Clear selected users error when audience changes away from targeted
      if (field === 'targetAudience') {
        setValidationErrors((prev) => ({
          ...prev,
          selectedUserIds: undefined,
        }))
      }
    }
  }

  const handleBlur = (field: string) => {
    setTouchedFields((prev) => new Set(prev).add(field))
    const error = validateField(field, formData[field as keyof NotificationFormData] as string)
    if (error) {
      setValidationErrors((prev) => ({
        ...prev,
        [field]: getErrorMessage(error),
      }))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    const trimmed = trimFormStrings(formData)
    const normalized = trimmed.schedule === 'Schedule for Later'
      ? { ...trimmed, scheduledTime: '13:00' }
      : trimmed

    // Mark all fields as touched to show validation errors
    setTouchedFields(new Set(['title', 'message', 'scheduledAt', 'scheduledTime', 'selectedUserIds']))
    
    // Validate form using trimmed data
    const { isValid, errors } = validateForm(normalized)
    
    if (!isValid) {
      console.error('Validation failed:', errors)
      return
    }

    setIsSubmitting(true)
    try {
      await onSave({ ...normalized, type: 'Notification' })
      setShowUnsavedChangesModal(false)
      setFormData(createEmptyNotificationForm())
      setValidationErrors({})
      setTouchedFields(new Set())
      onClose()
    } catch (error) {
      console.error('Error saving notification:', error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    if (hasUnsavedChanges && !isSubmitting) {
      setShowUnsavedChangesModal(true)
    } else {
      setFormData(createEmptyNotificationForm())
      onClose()
    }
  }

  const handleDiscardChanges = () => {
    setShowUnsavedChangesModal(false)
    setFormData(createEmptyNotificationForm())
    onClose()
  }

  const handleUserSelect = (userId: string) => {
    setFormData((prev) => {
      const selectedUserIds = prev.selectedUserIds || []
      if (selectedUserIds.includes(userId)) {
        return { ...prev, selectedUserIds: selectedUserIds.filter((id) => id !== userId) }
      } else {
        return { ...prev, selectedUserIds: [...selectedUserIds, userId] }
      }
    })

    // Clear user selection error once at least one user is selected
    setValidationErrors((prev) => ({
      ...prev,
      selectedUserIds: undefined,
    }))
  }

  const handleRemoveUser = (userId: string) => {
    setFormData((prev) => ({
      ...prev,
      selectedUserIds: (prev.selectedUserIds || []).filter((id) => id !== userId),
    }))
  }

  const getUserDisplayName = (user: AppUser): string =>
    user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.username || user.email || 'Unknown User'

  // Token-based so picking a recipient by full name works: testing each field against the whole
  // query meant "Kelsey Cooper" matched nobody, since no single field holds both words.
  const filteredUsers = users.filter((user) =>
    matchesAllTokens(
      [user.firstName, user.lastName, user.email, user.username],
      userSearchQuery
    )
  ).sort((a, b) => getUserDisplayName(a).localeCompare(getUserDisplayName(b), undefined, { sensitivity: 'base' }))

  return (
    <>
      <UnsavedChangesModal
        isOpen={showUnsavedChangesModal}
        onDiscard={handleDiscardChanges}
        onCancel={() => setShowUnsavedChangesModal(false)}
      />
      
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

        {/* Modal */}
        <div className="relative bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto m-4">
          {/* Header */}
          <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">
                {isEditMode ? 'Edit Notification' : 'Create Notification'}
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                {isEditMode 
                  ? 'Update the notification details below.'
                  : 'Send targeted push notifications to your app users.'}
              </p>
            </div>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              disabled={isSubmitting}
            >
              <Icon icon="mdi:close" className="w-6 h-6" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} data-notification-form className="p-6">
          {/* Required fields note */}
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-start gap-2">
              <Icon icon="mdi:information" className="w-5 h-5 text-blue-600 mt-0.5" />
              <div>
                <p className="text-sm text-blue-800 font-medium">Required Fields</p>
                <p className="text-xs text-blue-600 mt-1">
                  Fields marked with <span className="text-red-500">*</span> are required
                </p>
              </div>
            </div>
          </div>

          {/* Section 1: Content */}
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-full bg-[#1D0A74] text-white flex items-center justify-center font-semibold text-sm">
                1
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Content</h3>
            </div>
            <div className="ml-11 space-y-4">
              {/* Notification Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Notification Title <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="Enter notification title"
                  value={formData.title}
                  onChange={(e) => handleInputChange('title', e.target.value)}
                  onBlur={() => handleBlur('title')}
                  className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:border-transparent ${
                    validationErrors.title
                      ? 'border-red-500 focus:ring-red-500'
                      : 'border-gray-300 focus:ring-[#1D0A74]'
                  }`}
                />
                {validationErrors.title && (
                  <div className="flex items-center gap-1 mt-1 text-red-500 text-sm">
                    <Icon icon="mdi:alert-circle" className="w-4 h-4" />
                    <span>{validationErrors.title}</span>
                  </div>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  {formData.title.length}/{VALIDATION_RULES.title.maxLength} characters
                </p>
              </div>

              {/* Message */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Message <span className="text-red-500">*</span>
                </label>
                <textarea
                  placeholder="Enter notification message"
                  value={formData.message}
                  onChange={(e) => handleInputChange('message', e.target.value)}
                  onBlur={() => handleBlur('message')}
                  rows={4}
                  className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:border-transparent resize-none ${
                    validationErrors.message
                      ? 'border-red-500 focus:ring-red-500'
                      : 'border-gray-300 focus:ring-[#1D0A74]'
                  }`}
                />
                {validationErrors.message && (
                  <div className="flex items-center gap-1 mt-1 text-red-500 text-sm">
                    <Icon icon="mdi:alert-circle" className="w-4 h-4" />
                    <span>{validationErrors.message}</span>
                  </div>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  {formData.message.length}/{VALIDATION_RULES.message.maxLength} characters
                </p>
              </div>

              {/* Template picker */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Template (optional)
                </label>
                <div className="relative">
                  <select
                    value={selectedAppTemplateId}
                    onChange={(e) => {
                      const id = e.target.value
                      setSelectedAppTemplateId(id)
                      const t = APP_PUSH_TEMPLATES.find((x) => x.id === id)
                      if (t && t.title) {
                        setFormData((prev) => ({ ...prev, title: t.title, message: t.body }))
                      }
                    }}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent appearance-none bg-white pr-10"
                  >
                    {APP_PUSH_TEMPLATES.map((t) => (
                      <option key={t.id || 'none'} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <Icon
                    icon="mdi:chevron-down"
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Prefills title and message. You can edit placeholders (e.g. Store Name, Time, Brand) after selecting.
                </p>
              </div>
            </div>
          </div>

          {/* Section 2: Audience */}
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-full bg-[#1D0A74] text-white flex items-center justify-center font-semibold text-sm">
                2
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Audience</h3>
            </div>
            <div className="ml-11 space-y-4">
              {/* Target Audience */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Target Audience
                  </label>
                  <div className="relative">
                    <select
                      value={formData.targetAudience}
                      onChange={(e) => {
                        const audience = e.target.value as NotificationAudience
                        setFormData((prev) => ({
                          ...prev,
                          targetAudience: audience,
                          selectedUserIds: [],
                          selectedZipCodes: [],
                          newUsersTimeRange: undefined,
                        }))
                      }}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent appearance-none bg-white pr-10"
                    >
                      <optgroup label="App Push Notifications">
                        <option value="All">All Users</option>
                        <option value="NewUsers">New Users</option>
                        <option value="BrandAmbassadors">Certified Brand Ambassadors (BA)</option>
                        <option value="Influencers">Certified Influencers</option>
                        <option value="Tier1">Tier 1 Users - NewbieSamplers</option>
                        <option value="Tier2">Tier 2 Users - SampleFans</option>
                        <option value="Tier3">Tier 3 Users - SuperSamplers</option>
                        <option value="Tier4">Tier 4 Users - VIS</option>
                        <option value="Tier5">Tier 5 Users - SampleMasters</option>
                        <option value="ZipCode">
                          All Users within specific zip code area (multi-select)
                        </option>
                        <option value="Targeted">Specific Users</option>
                      </optgroup>
                    </select>
                    <Icon
                      icon="mdi:chevron-down"
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none"
                    />
                  </div>
                </div>

                {/* New Users time range */}
                {formData.targetAudience === 'NewUsers' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      New Users Time Range (days)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={formData.newUsersTimeRange ?? ''}
                      onChange={(e) => {
                        const val = e.target.value
                          ? Math.max(1, Math.min(365, Number(e.target.value)))
                          : undefined
                        setFormData((prev) => ({ ...prev, newUsersTimeRange: val }))
                      }}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
                      placeholder="e.g. 30"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Send to users who signed up within the last N days.
                    </p>
                  </div>
                )}

                {/* Zip code multi-select */}
                {formData.targetAudience === 'ZipCode' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Zip Codes
                    </label>
                    <div className="relative">
                      <select
                        multiple
                        value={formData.selectedZipCodes || []}
                        onChange={(e) => {
                          const options = Array.from(e.target.selectedOptions).map((o) => o.value)
                          handleInputChange('selectedZipCodes', options.join(','))
                          setFormData((prev) => ({
                            ...prev,
                            selectedZipCodes: options,
                          }))
                        }}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent min-h-[120px]"
                      >
                        {isLoadingZipCodes && (
                          <option disabled>Loading zip codes...</option>
                        )}
                        {!isLoadingZipCodes &&
                          availableZipCodes.map((zip) => (
                            <option key={zip} value={zip}>
                              {zip}
                            </option>
                          ))}
                      </select>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Hold Ctrl (Windows) or Command (Mac) to select multiple zip codes.
                    </p>
                  </div>
                )}

                {/* User Selection for Targeted audience */}
                {formData.targetAudience === 'Targeted' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Select Users
                    </label>
                    
                    {/* Selected users display */}
                    {formData.selectedUserIds && formData.selectedUserIds.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-2">
                        {formData.selectedUserIds.map((userId) => {
                          const user = users.find((u) => u.$id === userId)
                          if (!user) return null
                          const displayName = getUserDisplayName(user)
                          return (
                            <div
                              key={userId}
                              className="inline-flex items-center gap-2 px-3 py-1 bg-[#1D0A74] text-white rounded-full text-sm"
                            >
                              <span>{displayName}</span>
                              <button
                                type="button"
                                onClick={() => handleRemoveUser(userId)}
                                className="hover:bg-white/20 rounded-full p-0.5"
                              >
                                <Icon icon="mdi:close" className="w-4 h-4" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* User search and selection dropdown */}
                    <div className="relative user-dropdown-container">
                      <div className="relative">
                        <input
                          type="text"
                          placeholder="Search users by name, email or username..."
                          value={userSearchQuery}
                          onChange={(e) => setUserSearchQuery(e.target.value)}
                          onFocus={() => setShowUserDropdown(true)}
                          className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
                        />
                        <Icon
                          icon="mdi:magnify"
                          className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400"
                        />
                      </div>

                      {/* Dropdown list */}
                      {showUserDropdown && (
                        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                          {loadingUsers ? (
                            <div className="px-4 py-3 text-center text-gray-500">
                              <Icon icon="mdi:loading" className="w-5 h-5 animate-spin mx-auto" />
                            </div>
                          ) : filteredUsers.length === 0 ? (
                            <div className="px-4 py-3 text-center text-gray-500">
                              No users found
                            </div>
                          ) : (
                            <>
                              {filteredUsers.map((user) => {
                                const isSelected = formData.selectedUserIds?.includes(user.$id)
                                const displayName = getUserDisplayName(user)
                                return (
                                  <div
                                    key={user.$id}
                                    onClick={() => handleUserSelect(user.$id)}
                                    className={`px-4 py-2 cursor-pointer hover:bg-gray-100 flex items-center justify-between ${
                                      isSelected ? 'bg-blue-50' : ''
                                    }`}
                                  >
                                    <div>
                                      <div className="font-medium text-gray-900">{displayName}</div>
                                      {user.email && (
                                        <div className="text-xs text-gray-500">{user.email}</div>
                                      )}
                                    </div>
                                    {isSelected && (
                                      <Icon icon="mdi:check" className="w-5 h-5 text-[#1D0A74]" />
                                    )}
                                  </div>
                                )
                              })}
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    <p className="text-xs text-gray-500 mt-1">
                      Selected {formData.selectedUserIds?.length || 0} user(s)
                    </p>
                    {validationErrors.selectedUserIds && (
                      <p className="mt-1 text-sm text-red-600">{validationErrors.selectedUserIds}</p>
                    )}
                  </div>
                )}
            </div>
          </div>

          {/* Schedule Section */}
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-full bg-[#1D0A74] text-white flex items-center justify-center font-semibold text-sm">
                3
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Schedule</h3>
            </div>
            <div className="ml-11 space-y-4">
              {/* When to send */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  When to send?
                </label>
                <div className="relative">
                  <select
                    value={formData.schedule}
                    onChange={(e) => handleInputChange('schedule', e.target.value as 'Send Immediately' | 'Schedule for Later')}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent appearance-none bg-white pr-10"
                  >
                    <option value="Send Immediately">Send Immediately</option>
                    <option value="Schedule for Later">Schedule for Later</option>
                  </select>
                  <Icon
                    icon="mdi:chevron-down"
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none"
                  />
                </div>
              </div>

              {/* Date and Time pickers for scheduled notifications */}
              {formData.schedule === 'Schedule for Later' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Scheduled Date <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="date"
                      value={formData.scheduledAt}
                      onChange={(e) => handleInputChange('scheduledAt', e.target.value)}
                      onBlur={() => handleBlur('scheduledAt')}
                      min={minScheduledDate}
                      className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:border-transparent ${
                        validationErrors.scheduledAt || validationErrors.scheduledTime
                          ? 'border-red-500 focus:ring-red-500'
                          : 'border-gray-300 focus:ring-[#1D0A74]'
                      }`}
                    />
                    {(validationErrors.scheduledAt || validationErrors.scheduledTime) && (
                      <div className="flex items-center gap-1 mt-1 text-red-500 text-sm">
                        <Icon icon="mdi:alert-circle" className="w-4 h-4" />
                        <span>
                          {validationErrors.scheduledAt || validationErrors.scheduledTime}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
                    Scheduled notifications are sent at <span className="font-semibold">1:00 PM EST</span>.
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-4 pt-4 border-t border-gray-200">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-6 py-3 bg-[#1D0A74] text-white rounded-lg hover:bg-[#15065c] transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Icon icon="mdi:loading" className="w-5 h-5 animate-spin" />
                  {isEditMode ? 'Updating...' : 'Creating...'}
                </span>
              ) : (
                isEditMode ? 'Update Notification' : 'Create Notification'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
    </>
  )
}

export default CreateNotificationModal

