import { useState, useEffect, useRef } from 'react'
import { Icon } from '@iconify/react'
import {
  tiersService,
  type TierDocument,
  appUsersService,
  userProfilesService,
} from '../../../lib/services'
import { useUnsavedChanges } from '../../../hooks/useUnsavedChanges'
import { UnsavedChangesModal } from '../../../components'
import { Query } from '../../../lib/appwrite'
import { trimFormStrings } from '../../../lib/formUtils'

interface AddUserModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (userData: {
    email: string
    password: string
    firstName: string
    lastName: string
    username: string
    phoneNumber: string
    role: string
    tierLevel?: string
    totalPoints?: number
    dob?: string
    zipCode?: string
    image?: File | null
  }) => void
}

const AddUserModal = ({ isOpen, onClose, onSave }: AddUserModalProps) => {
  const initialFormData = {
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    username: '',
    phoneNumber: '',
    role: 'user', // Default role
    tierLevel: '',
    dob: '',
    zipCode: '',
    image: null as File | null,
  }

  const [formData, setFormData] = useState(initialFormData)
  const initialDataRef = useRef(initialFormData)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

  const [showPassword, setShowPassword] = useState(false)
  const [tiers, setTiers] = useState<TierDocument[]>([])
  const [isLoadingTiers, setIsLoadingTiers] = useState(false)
  const [showUnsavedChangesModal, setShowUnsavedChangesModal] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [usernameValidation, setUsernameValidation] = useState<{
    isChecking: boolean
    isAvailable: boolean | null
    message: string
  }>({
    isChecking: false,
    isAvailable: null,
    message: ''
  })
  const [emailValidation, setEmailValidation] = useState<{
    isChecking: boolean
    isAvailable: boolean | null
    message: string
  }>({
    isChecking: false,
    isAvailable: null,
    message: ''
  })
  const [phoneValidation, setPhoneValidation] = useState<{
    isChecking: boolean
    isAvailable: boolean | null
    message: string
  }>({
    isChecking: false,
    isAvailable: null,
    message: ''
  })
  const usernameCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const emailCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const phoneCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [passwordError, setPasswordError] = useState('')
  const [firstNameError, setFirstNameError] = useState('')
  const [lastNameError, setLastNameError] = useState('')
  const [usernameError, setUsernameError] = useState('')
  const [emailError, setEmailError] = useState('')
  const [dobError, setDobError] = useState('')
  const [zipCodeError, setZipCodeError] = useState('')
  
  const hasUnsavedChanges = useUnsavedChanges(formData, initialDataRef.current, isOpen)

  // Email format validation
  const validateEmailFormat = (email: string): string => {
    if (!email) return 'Email is required'
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) return 'Email is required'
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(trimmed)) return 'Please enter a valid email address'
    return ''
  }

  // Password validation: min 8 chars, at least one letter, one number, one uppercase, and one special character
  const validatePassword = (password: string): string => {
    if (!password) return 'Password is required'
    if (password.length < 8) return 'Password must be at least 8 characters'
    if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least one letter'
    if (!/\d/.test(password)) return 'Password must contain at least one number'
    if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter'
    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
      return 'Password must contain at least one special character'
    }
    return ''
  }

  // Name validation: alphabetic words separated by single spaces, each starting with capital
  const validateName = (name: string, fieldName: string): string => {
    if (!name) return `${fieldName} is required`
    if (!/^[A-Z][a-zA-Z]*(?: [A-Z][a-zA-Z]*)*$/.test(name)) {
      return `${fieldName} must contain only alphabets, and each word must start with a capital letter`
    }
    return ''
  }

  // Username validation: character limit
  const validateUsername = (username: string): string => {
    const maxLength = 20
    if (!username) return 'Username is required'
    if (username.length > maxLength) {
      return `Username must not exceed ${maxLength} characters`
    }
    return ''
  }

  // DOB validation: required on admin add user flow
  const validateDob = (dob: string): string => {
    if (!dob) return 'Date of Birth is required'
    return ''
  }

  // Zip code: required, 5 or 6 digits (US ZIP plus optional extended)
  const validateZipCode = (zipCode: string): string => {
    if (!zipCode) return 'Zip Code is required'
    if (zipCode.length < 5) return 'Zip Code must be at least 5 digits'
    return ''
  }

  // Fetch tiers when modal opens
  useEffect(() => {
    if (isOpen) {
      const fetchTiers = async () => {
        setIsLoadingTiers(true)
        try {
          const tiersList = await tiersService.list()
          setTiers(tiersList)
          // Set default tier to the lowest tier (first in sorted list)
          if (tiersList.length > 0) {
            const newInitialData = { ...initialFormData, tierLevel: tiersList[0].name }
            setFormData(newInitialData)
            initialDataRef.current = newInitialData
          }
        } catch (error) {
          console.error('Error fetching tiers:', error)
        } finally {
          setIsLoadingTiers(false)
        }
      }
      fetchTiers()
    }
  }, [isOpen])

  // Check username availability with debounce
  const checkUsernameAvailability = async (username: string) => {
    if (!username.trim()) {
      setUsernameValidation({
        isChecking: false,
        isAvailable: null,
        message: ''
      })
      return
    }

    setUsernameValidation({
      isChecking: true,
      isAvailable: null,
      message: 'Checking availability...'
    })

    try {
      // userProfilesService, not appUsersService: the latter resolves an Auth email for every
      // matched profile through the get-user-emails Function, and this check runs per keystroke.
      // Username lives on the profile, so the extra round trip bought nothing.
      const result = await userProfilesService.list([
        Query.select(['$id', 'username']),
        Query.equal('username', username.trim()),
        Query.limit(1),
      ])

      if (result.documents.length > 0) {
        setUsernameValidation({
          isChecking: false,
          isAvailable: false,
          message: 'Username already exists'
        })
      } else {
        setUsernameValidation({
          isChecking: false,
          isAvailable: true,
          message: 'Username is available'
        })
      }
    } catch (error) {
      console.error('Error checking username:', error)
      setUsernameValidation({
        isChecking: false,
        isAvailable: null,
        message: ''
      })
    }
  }

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (usernameCheckTimeoutRef.current) {
        clearTimeout(usernameCheckTimeoutRef.current)
      }
      if (emailCheckTimeoutRef.current) {
        clearTimeout(emailCheckTimeoutRef.current)
      }
      if (phoneCheckTimeoutRef.current) {
        clearTimeout(phoneCheckTimeoutRef.current)
      }
    }
  }, [])

  if (!isOpen) return null

  // Format phone number to (XXX) XXX-XXXX
  const formatPhoneNumber = (value: string) => {
    // Remove all non-digits
    const phoneNumber = value.replace(/\D/g, '')
    
    // Limit to 10 digits
    const limitedNumber = phoneNumber.slice(0, 10)
    
    // Format based on length
    if (limitedNumber.length <= 3) {
      return limitedNumber
    } else if (limitedNumber.length <= 6) {
      return `(${limitedNumber.slice(0, 3)}) ${limitedNumber.slice(3)}`
    } else {
      return `(${limitedNumber.slice(0, 3)}) ${limitedNumber.slice(3, 6)}-${limitedNumber.slice(6)}`
    }
  }

  const handleInputChange = (field: string, value: string) => {
    // Format phone number automatically and check availability when fully entered
    if (field === 'phoneNumber') {
      const formatted = formatPhoneNumber(value)
      setFormData((prev) => ({ ...prev, [field]: formatted }))

      if (phoneCheckTimeoutRef.current) {
        clearTimeout(phoneCheckTimeoutRef.current)
        phoneCheckTimeoutRef.current = null
      }

      const digitsOnly = formatted.replace(/\D/g, '')

      // Only check when we have 10 digits (fully entered US number)
      if (digitsOnly.length === 10) {
        setPhoneValidation({
          isChecking: true,
          isAvailable: null,
          message: 'Checking phone number...',
        })

        const formattedForQuery = formatted
        phoneCheckTimeoutRef.current = setTimeout(async () => {
          try {
            // Profile-only lookup — see the username check above for why this avoids appUsersService.
            const result = await userProfilesService.list([
              Query.select(['$id', 'phoneNumber']),
              Query.equal('phoneNumber', formattedForQuery),
              Query.limit(1),
            ])

            if (result.total > 0) {
              setPhoneValidation({
                isChecking: false,
                isAvailable: false,
                message: 'Phone number already exists',
              })
            } else {
              setPhoneValidation({
                isChecking: false,
                isAvailable: true,
                message: 'Phone number is available',
              })
            }
          } catch (error) {
            console.error('Error checking phone number:', error)
            setPhoneValidation({
              isChecking: false,
              isAvailable: null,
              message: '',
            })
          }
        }, 500)
      } else {
        setPhoneValidation({
          isChecking: false,
          isAvailable: null,
          message: '',
        })
      }

      return
    }
    
    // Allow alphabetic names with spaces and auto-capitalize each word
    if (field === 'firstName' || field === 'lastName') {
      // Keep only letters/spaces, collapse multiple spaces, and preserve one trailing space while typing.
      const lettersAndSpaces = value.replace(/[^a-zA-Z\s]/g, '')
      const hasTrailingSpace = /\s$/.test(lettersAndSpaces)
      const normalizedBase = lettersAndSpaces
        .replace(/\s+/g, ' ')
        .trimStart()
      const words = normalizedBase
        .trim()
        .split(' ')
        .filter(Boolean)
      const capitalizedWords = words.map(
        (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      )
      const capitalizedValue =
        capitalizedWords.join(' ') + (hasTrailingSpace && capitalizedWords.length > 0 ? ' ' : '')
      setFormData((prev) => ({ ...prev, [field]: capitalizedValue }))
      
      if (field === 'firstName') {
        setFirstNameError(validateName(capitalizedValue, 'First Name'))
      }
      
      if (field === 'lastName') {
        setLastNameError(validateName(capitalizedValue, 'Last Name'))
      }
      return
    }
    
    // Limit username to 20 characters
    if (field === 'username') {
      const maxLength = 20
      const limitedValue = value.slice(0, maxLength)
      setFormData((prev) => ({ ...prev, [field]: limitedValue }))
      setUsernameError(validateUsername(limitedValue))
      if (usernameCheckTimeoutRef.current) {
        clearTimeout(usernameCheckTimeoutRef.current)
        usernameCheckTimeoutRef.current = null
      }
      if (!limitedValue.trim()) {
        setUsernameValidation({ isChecking: false, isAvailable: null, message: '' })
      } else {
        usernameCheckTimeoutRef.current = setTimeout(() => {
          checkUsernameAvailability(limitedValue)
        }, 500)
      }
      return
    }

    // Email: format validation and debounced uniqueness check
    if (field === 'email') {
      setFormData((prev) => ({ ...prev, [field]: value }))
      const formatErr = validateEmailFormat(value)
      setEmailError(formatErr)

      if (emailCheckTimeoutRef.current) {
        clearTimeout(emailCheckTimeoutRef.current)
        emailCheckTimeoutRef.current = null
      }

      const trimmed = value.trim().toLowerCase()
      if (!trimmed || formatErr) {
        setEmailValidation({
          isChecking: false,
          isAvailable: null,
          message: '',
        })
        return
      }

      setEmailValidation({
        isChecking: true,
        isAvailable: null,
        message: 'Checking email...',
      })

      emailCheckTimeoutRef.current = setTimeout(async () => {
        try {
          const result = await appUsersService.checkEmailAvailability(trimmed)
          if (result.exists) {
            setEmailValidation({
              isChecking: false,
              isAvailable: false,
              message: 'Email already exists',
            })
          } else {
            setEmailValidation({
              isChecking: false,
              isAvailable: true,
              message: 'Email is available',
            })
          }
        } catch (error) {
          console.error('Error checking email:', error)
          setEmailValidation({
            isChecking: false,
            isAvailable: null,
            message: '',
          })
        }
      }, 500)

      return
    }

    if (field === 'dob') {
      setFormData((prev) => ({ ...prev, [field]: value }))
      setDobError(validateDob(value.trim()))
      return
    }

    // Zip code - digits only, max 6 chars (mirrors EditUserModal)
    if (field === 'zipCode') {
      const numericValue = value.replace(/\D/g, '').slice(0, 6)
      setFormData((prev) => ({ ...prev, [field]: numericValue }))
      setZipCodeError(validateZipCode(numericValue))
      return
    }

    setFormData((prev) => ({ ...prev, [field]: value }))

    if (field === 'password') {
      setPasswordError(validatePassword(value))
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFormData((prev) => ({ ...prev, image: file }))
    const reader = new FileReader()
    reader.onloadend = () => setImagePreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleDeleteImage = () => {
    setFormData((prev) => ({ ...prev, image: null }))
    setImagePreview(null)
    const input = document.getElementById('add-user-image-upload') as HTMLInputElement | null
    if (input) input.value = ''
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const { image, ...stringFields } = formData
    const trimmed = { ...trimFormStrings(stringFields), image }
    
    const pwdError = validatePassword(trimmed.password)
    const fnError = validateName(trimmed.firstName, 'First Name')
    const lnError = validateName(trimmed.lastName, 'Last Name')
    const unError = validateUsername(trimmed.username)
    const emailFormatErr = validateEmailFormat(trimmed.email)
    const birthDateError = validateDob(trimmed.dob)
    const zipErr = validateZipCode(trimmed.zipCode)

    setPasswordError(pwdError)
    setFirstNameError(fnError)
    setLastNameError(lnError)
    setUsernameError(unError)
    setEmailError(emailFormatErr)
    setDobError(birthDateError)
    setZipCodeError(zipErr)

    if (pwdError || fnError || lnError || unError || emailFormatErr || birthDateError || zipErr) return

    // Prevent submission if email or phone are known to be unavailable
    if (trimmed.email && emailValidation.isAvailable === false) {
      return
    }
    if (trimmed.phoneNumber && phoneValidation.isAvailable === false) {
      return
    }

    // Prevent submission if username is required but not available
    if (trimmed.username && usernameValidation.isAvailable === false) {
      return
    }
    
    setIsSubmitting(true)
    try {
      const selectedTier = tiers.find((t) => t.name === trimmed.tierLevel)
      const totalPoints = selectedTier?.requiredPoints ?? 100
      await onSave({ ...trimmed, totalPoints })
      // Close unsaved changes modal if it's open
      setShowUnsavedChangesModal(false)
      // Reset form and validation state
      setFormData(initialFormData)
      setImagePreview(null)
      setShowPassword(false)
      setPasswordError('')
      setFirstNameError('')
      setLastNameError('')
      setUsernameError('')
      setEmailError('')
      setDobError('')
      setZipCodeError('')
      setUsernameValidation({
        isChecking: false,
        isAvailable: null,
        message: ''
      })
      setEmailValidation({
        isChecking: false,
        isAvailable: null,
        message: ''
      })
      setPhoneValidation({
        isChecking: false,
        isAvailable: null,
        message: ''
      })
      onClose()
    } catch (error) {
      // Error handled by parent
      console.error('Error saving user:', error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    if (hasUnsavedChanges && !isSubmitting) {
      setShowUnsavedChangesModal(true)
    } else {
      // Reset form on close
      setFormData(initialFormData)
      setImagePreview(null)
      setShowPassword(false)
      setPasswordError('')
      setFirstNameError('')
      setLastNameError('')
      setUsernameError('')
      setEmailError('')
      setDobError('')
      setZipCodeError('')
      setUsernameValidation({
        isChecking: false,
        isAvailable: null,
        message: ''
      })
      setEmailValidation({
        isChecking: false,
        isAvailable: null,
        message: ''
      })
      setPhoneValidation({
        isChecking: false,
        isAvailable: null,
        message: ''
      })
      onClose()
    }
  }

  const handleDiscardChanges = () => {
    setShowUnsavedChangesModal(false)
    setFormData(initialFormData)
    setImagePreview(null)
    setShowPassword(false)
    setPasswordError('')
    setFirstNameError('')
    setLastNameError('')
    setUsernameError('')
    setEmailError('')
    setDobError('')
    setUsernameValidation({
      isChecking: false,
      isAvailable: null,
      message: ''
    })
    setEmailValidation({
      isChecking: false,
      isAvailable: null,
      message: ''
    })
    setPhoneValidation({
      isChecking: false,
      isAvailable: null,
      message: ''
    })
    onClose()
  }

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
              <h2 className="text-2xl font-bold text-gray-900">Add User</h2>
              <p className="text-sm text-gray-600 mt-1">
                Add a new user to the system.
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
          <form onSubmit={handleSubmit} data-user-form autoComplete="off" className="p-6">
          {/* Hidden decoy fields reduce browser autofill on real inputs inside the modal */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
          />
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
          />
          {/* Image Section (optional) */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Image
              <span className="text-xs text-gray-500 font-normal ml-2">(optional)</span>
            </label>
            <div className="flex items-center gap-4">
              <div className="relative">
                {imagePreview ? (
                  <img
                    src={imagePreview}
                    alt="User profile preview"
                    className="w-24 h-24 rounded-full object-cover border-2 border-gray-200"
                  />
                ) : (
                  <div className="w-24 h-24 rounded-full bg-gray-200 flex items-center justify-center border-2 border-gray-300">
                    <Icon icon="mdi:account" className="w-12 h-12 text-gray-400" />
                  </div>
                )}
              </div>
              <div className="flex gap-3">
                <label className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors cursor-pointer font-medium text-sm">
                  {imagePreview ? 'Change' : 'Upload'}
                  <input
                    id="add-user-image-upload"
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </label>
                {imagePreview && (
                  <button
                    type="button"
                    onClick={handleDeleteImage}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium text-sm"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Form Fields */}
          <div className="space-y-4 mb-6">
            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email <span className="text-red-500">*</span>
              </label>
            <div className="relative">
              <input
                type="email"
                name="admin-create-user-email"
                autoComplete="off"
                placeholder="Enter Email"
                value={formData.email}
                onChange={(e) => handleInputChange('email', e.target.value)}
                required
                className={`w-full px-4 py-2 pr-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent ${
                  emailError
                    ? 'border-red-500'
                    : formData.email.trim()
                    ? emailValidation.isAvailable === false
                      ? 'border-red-500'
                      : emailValidation.isAvailable === true
                      ? 'border-green-500'
                      : 'border-gray-300'
                    : 'border-gray-300'
                }`}
              />
              {formData.email.trim() && emailValidation.isChecking && (
                <Icon
                  icon="mdi:loading"
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 animate-spin"
                />
              )}
              {formData.email.trim() && !emailValidation.isChecking && emailValidation.isAvailable === true && (
                <Icon
                  icon="mdi:check-circle"
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-green-500"
                />
              )}
              {formData.email.trim() && !emailValidation.isChecking && emailValidation.isAvailable === false && (
                <Icon
                  icon="mdi:close-circle"
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-red-500"
                />
              )}
            </div>
            {emailError && (
              <p className="mt-1 text-xs text-red-500">{emailError}</p>
            )}
            {!emailError && formData.email.trim() && emailValidation.message && (
              <p
                className={`mt-1 text-xs ${
                  emailValidation.isAvailable === false
                    ? 'text-red-500'
                    : emailValidation.isAvailable === true
                    ? 'text-green-500'
                    : 'text-gray-500'
                }`}
              >
                {emailValidation.message}
              </p>
            )}
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Password <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="admin-create-user-password"
                  autoComplete="new-password"
                  placeholder="Enter Password (min 8 chars with letter, number, uppercase, special char)"
                  value={formData.password}
                  onChange={(e) => handleInputChange('password', e.target.value)}
                  required
                  className={`w-full px-4 py-2 pr-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent ${
                    passwordError ? 'border-red-500' : 'border-gray-300'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <Icon
                    icon={showPassword ? 'mdi:eye-off' : 'mdi:eye'}
                    className="w-5 h-5"
                  />
                </button>
              </div>
              {passwordError && (
                <p className="mt-1 text-xs text-red-500">{passwordError}</p>
              )}
            </div>

            {/* First Name + Last Name */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  First Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="Enter First Name"
                  value={formData.firstName}
                  onChange={(e) => handleInputChange('firstName', e.target.value)}
                  required
                  className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent ${
                    firstNameError ? 'border-red-500' : 'border-gray-300'
                  }`}
                />
                {firstNameError && (
                  <p className="mt-1 text-xs text-red-500">{firstNameError}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Last Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="Enter Last Name"
                  value={formData.lastName}
                  onChange={(e) => handleInputChange('lastName', e.target.value)}
                  required
                  className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent ${
                    lastNameError ? 'border-red-500' : 'border-gray-300'
                  }`}
                />
                {lastNameError && (
                  <p className="mt-1 text-xs text-red-500">{lastNameError}</p>
                )}
              </div>
            </div>

            {/* Date of Birth */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Date of Birth <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={formData.dob}
                onChange={(e) => handleInputChange('dob', e.target.value)}
                required
                className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent ${
                  dobError ? 'border-red-500' : 'border-gray-300'
                }`}
              />
              {dobError && (
                <p className="mt-1 text-xs text-red-500">{dobError}</p>
              )}
            </div>

            {/* Zip Code + Username */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Zip Code <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="Enter Zip Code"
                  value={formData.zipCode}
                  onChange={(e) => handleInputChange('zipCode', e.target.value)}
                  inputMode="numeric"
                  required
                  className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent ${
                    zipCodeError ? 'border-red-500' : 'border-gray-300'
                  }`}
                />
                {zipCodeError && (
                  <p className="mt-1 text-xs text-red-500">{zipCodeError}</p>
                )}
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 flex items-center justify-between">
                  <span>
                    Username <span className="text-red-500">*</span>
                  </span>
                  <span className="text-xs text-gray-500 font-normal">
                    {formData.username.length}/20 characters
                  </span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Enter Username"
                    value={formData.username}
                    onChange={(e) => handleInputChange('username', e.target.value)}
                    maxLength={20}
                    required
                    className={`w-full px-4 py-2 pr-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent ${
                      formData.username.trim()
                        ? usernameValidation.isAvailable === false
                          ? 'border-red-500'
                          : usernameValidation.isAvailable === true
                          ? 'border-green-500'
                          : 'border-gray-300'
                        : 'border-gray-300'
                    }`}
                  />
                  {formData.username.trim() && usernameValidation.isChecking && (
                    <Icon
                      icon="mdi:loading"
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 animate-spin"
                    />
                  )}
                  {formData.username.trim() && !usernameValidation.isChecking && usernameValidation.isAvailable === true && (
                    <Icon
                      icon="mdi:check-circle"
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-green-500"
                    />
                  )}
                  {formData.username.trim() && !usernameValidation.isChecking && usernameValidation.isAvailable === false && (
                    <Icon
                      icon="mdi:close-circle"
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-red-500"
                    />
                  )}
                </div>
                {usernameError && (
                  <p className="mt-1 text-xs text-red-500">{usernameError}</p>
                )}
                {!usernameError && formData.username.trim() && usernameValidation.message && (
                  <p
                    className={`mt-1 text-xs ${
                      usernameValidation.isAvailable === false
                        ? 'text-red-500'
                        : usernameValidation.isAvailable === true
                        ? 'text-green-500'
                        : 'text-gray-500'
                    }`}
                  >
                    {usernameValidation.message}
                  </p>
                )}
              </div>
            </div>

            {/* Phone Number */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Phone Number <span className="text-red-500">*</span>
              </label>
            <div className="relative">
              <input
                type="tel"
                placeholder="Enter Phone Number"
                value={formData.phoneNumber}
                onChange={(e) => handleInputChange('phoneNumber', e.target.value)}
                required
                className={`w-full px-4 py-2 pr-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent ${
                  formData.phoneNumber.replace(/\D/g, '').length === 10
                    ? phoneValidation.isAvailable === false
                      ? 'border-red-500'
                      : phoneValidation.isAvailable === true
                      ? 'border-green-500'
                      : 'border-gray-300'
                    : 'border-gray-300'
                }`}
              />
              {formData.phoneNumber.replace(/\D/g, '').length === 10 && phoneValidation.isChecking && (
                <Icon
                  icon="mdi:loading"
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 animate-spin"
                />
              )}
              {formData.phoneNumber.replace(/\D/g, '').length === 10 &&
                !phoneValidation.isChecking &&
                phoneValidation.isAvailable === true && (
                  <Icon
                    icon="mdi:check-circle"
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-green-500"
                  />
                )}
              {formData.phoneNumber.replace(/\D/g, '').length === 10 &&
                !phoneValidation.isChecking &&
                phoneValidation.isAvailable === false && (
                  <Icon
                    icon="mdi:close-circle"
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-red-500"
                  />
                )}
            </div>
            {formData.phoneNumber.replace(/\D/g, '').length === 10 && phoneValidation.message && (
              <p
                className={`mt-1 text-xs ${
                  phoneValidation.isAvailable === false
                    ? 'text-red-500'
                    : phoneValidation.isAvailable === true
                    ? 'text-green-500'
                    : 'text-gray-500'
                }`}
              >
                {phoneValidation.message}
              </p>
            )}
            </div>

            {/* Role + Tier Level */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Role <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <select
                    value={formData.role}
                    onChange={(e) => handleInputChange('role', e.target.value)}
                    required
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent appearance-none bg-white pr-10"
                  >
                    <option value="admin">Admin</option>
                    <option value="user">User</option>
                  </select>
                  <Icon
                    icon="mdi:chevron-down"
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Tier Level <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <select
                    value={formData.tierLevel}
                    onChange={(e) => handleInputChange('tierLevel', e.target.value)}
                    required
                    disabled={isLoadingTiers}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent appearance-none bg-white pr-10 disabled:bg-gray-100 disabled:cursor-not-allowed"
                  >
                    {isLoadingTiers ? (
                      <option value="">Loading tiers...</option>
                    ) : tiers.length === 0 ? (
                      <option value="">No tiers available</option>
                    ) : (
                      <>
                        <option value="">Select a tier</option>
                        {tiers.map((tier) => (
                          <option key={tier.$id} value={tier.name}>
                            {tier.name}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                  <Icon
                    icon="mdi:chevron-down"
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-4 pt-4 border-t border-gray-200">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 px-6 py-3 bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-6 py-3 bg-[#1D0A74] text-white rounded-lg hover:bg-[#15065c] transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              disabled={
                isSubmitting ||
                !!passwordError ||
                !!firstNameError ||
                !!lastNameError ||
                !!usernameError ||
                !!emailError ||
                !!dobError ||
                !!zipCodeError ||
                (!!formData.username.trim() && usernameValidation.isAvailable === false) ||
                (!!formData.email.trim() && emailValidation.isAvailable === false) ||
                (formData.phoneNumber.replace(/\D/g, '').length === 10 && phoneValidation.isAvailable === false)
              }
            >
              {isSubmitting && <Icon icon="mdi:loading" className="w-5 h-5 animate-spin" />}
              {isSubmitting ? 'Adding User...' : 'Add User'}
            </button>
          </div>
        </form>
      </div>
    </div>
    </>
  )
}

export default AddUserModal

