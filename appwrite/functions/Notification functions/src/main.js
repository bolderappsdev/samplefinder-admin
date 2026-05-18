import { Client, Databases, Messaging, Users, ID, Query } from 'node-appwrite';
// Constants
const DATABASE_ID = '69217af50038b9005a61';
const NOTIFICATIONS_TABLE_ID = 'notifications';
const USER_PROFILES_TABLE_ID = 'user_profiles';
const EVENTS_TABLE_ID = 'events';
const SETTINGS_TABLE_ID = 'settings';
const PAGE_SIZE = 100;
/** Admin-scheduled notifications (notifications collection) send at 1:00 PM Eastern */
const NOTIFICATION_SEND_HOUR_EST = 13;
const EST_TIMEZONE = 'America/New_York';
/** App push campaigns that should feel like "morning" (Trivia Tuesday, Sampling Today, nearby favorite) */
const MORNING_START_HOUR_ET = 8;
const MORNING_END_HOUR_ET = 10; // exclusive: runs during 08:00–09:59 ET
const CLIENTS_TABLE_ID = 'clients';
function getTimePartsInTimezone(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const year = parseInt(parts.find((p) => p.type === 'year')?.value ?? '0', 10);
    const month = parseInt(parts.find((p) => p.type === 'month')?.value ?? '0', 10);
    const day = parseInt(parts.find((p) => p.type === 'day')?.value ?? '0', 10);
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    return { year, month, day, hour, minute };
}
function timezoneLocalToUTC(year, month, day, hour, minute, timezone) {
    let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    for (let i = 0; i < 5; i++) {
        const comp = getTimePartsInTimezone(new Date(guess), timezone);
        if (comp.year === year &&
            comp.month === month &&
            comp.day === day &&
            comp.hour === hour &&
            comp.minute === minute) {
            return new Date(guess);
        }
        const diffMs = (hour - comp.hour) * 36e5 +
            (minute - comp.minute) * 6e4 +
            (day - comp.day) * 864e5;
        guess += diffMs;
    }
    return new Date(guess);
}
function getNextOnePmEasternUTC(date = new Date()) {
    const nowEastern = getTimePartsInTimezone(date, EST_TIMEZONE);
    const useNextDay = nowEastern.hour > NOTIFICATION_SEND_HOUR_EST ||
        (nowEastern.hour === NOTIFICATION_SEND_HOUR_EST && nowEastern.minute > 0);
    const targetDay = new Date(Date.UTC(nowEastern.year, nowEastern.month - 1, nowEastern.day + (useNextDay ? 1 : 0)));
    const targetUtc = timezoneLocalToUTC(targetDay.getUTCFullYear(), targetDay.getUTCMonth() + 1, targetDay.getUTCDate(), NOTIFICATION_SEND_HOUR_EST, 0, EST_TIMEZONE);
    return targetUtc.toISOString();
}
function getEasternDateString(date) {
    const p = getTimePartsInTimezone(date, EST_TIMEZONE);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function isInMorningWindowET(date) {
    const { hour } = getTimePartsInTimezone(date, EST_TIMEZONE);
    return hour >= MORNING_START_HOUR_ET && hour < MORNING_END_HOUR_ET;
}
function isTuesdayEastern(date) {
    const wd = new Intl.DateTimeFormat('en-US', {
        timeZone: EST_TIMEZONE,
        weekday: 'short',
    }).format(date);
    return wd === 'Tue';
}
/**
 * Fetch all documents matching queries by paginating with limit/offset.
 * Appwrite defaults to 25 docs per request; this ensures we get every matching document.
 */
async function listAllDocuments(databases, databaseId, collectionId, queries = []) {
    // Cursor-based pagination: stable when the collection is being modified during the
    // fetch (signups, profile updates). Offset-based pagination would otherwise duplicate
    // some rows and skip others when ordering shifts across page boundaries — that
    // produced the "User A got 5 notifications, User B got 3" bug.
    const all = [];
    let cursorAfter = null;
    while (true) {
        const pageQueries = [...queries, Query.limit(PAGE_SIZE)];
        if (cursorAfter) {
            pageQueries.push(Query.cursorAfter(cursorAfter));
        }
        const response = await databases.listDocuments(databaseId, collectionId, pageQueries);
        if (response.documents.length === 0)
            break;
        all.push(...response.documents);
        cursorAfter = response.documents[response.documents.length - 1].$id;
        if (response.documents.length < PAGE_SIZE)
            break;
    }
    return all;
}
/**
 * Get notification by ID
 */
async function getNotification(databases, notificationId, log) {
    try {
        const notification = await databases.getDocument(DATABASE_ID, NOTIFICATIONS_TABLE_ID, notificationId);
        return notification;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Error fetching notification: ${errorMessage}`);
        throw new Error(`Failed to fetch notification: ${errorMessage}`);
    }
}
/**
 * Get target users based on audience type and selected user IDs / filters
 */
async function getTargetUsers(databases, targetAudience, selectedUserIds, log, notification) {
    try {
        // If specific users are selected (for Targeted audience), fetch only those users
        if (targetAudience === 'Targeted' && selectedUserIds && selectedUserIds.length > 0) {
            log(`Fetching ${selectedUserIds.length} specifically selected users`);
            const users = [];
            const TARGET_FETCH_CONCURRENCY = 40;
            for (let i = 0; i < selectedUserIds.length; i += TARGET_FETCH_CONCURRENCY) {
                const chunk = selectedUserIds.slice(i, i + TARGET_FETCH_CONCURRENCY);
                const settled = await Promise.allSettled(chunk.map((userId) => databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userId)));
                for (let j = 0; j < settled.length; j++) {
                    const r = settled[j];
                    if (r.status === 'fulfilled') {
                        users.push(r.value);
                    }
                    else {
                        const userId = chunk[j];
                        const errorMessage = r.reason instanceof Error ? r.reason.message : String(r.reason);
                        log(`Warning: Could not fetch user ${userId}: ${errorMessage}`);
                    }
                }
            }
            log(`Successfully fetched ${users.length} of ${selectedUserIds.length} selected users`);
            return users;
        }
        const queries = [];
        // Audience-based filtering
        if (targetAudience === 'NewUsers') {
            const days = notification?.newUsersTimeRange ?? 30;
            const now = new Date();
            const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
            log(`Filtering NewUsers with cutoff >= ${cutoff}`);
            queries.push(Query.greaterThanEqual('$createdAt', cutoff));
        }
        else if (targetAudience === 'BrandAmbassadors') {
            log('Filtering BrandAmbassadors (isAmbassador = true)');
            queries.push(Query.equal('isAmbassador', true));
        }
        else if (targetAudience === 'Influencers') {
            log('Filtering Influencers (isInfluencer = true)');
            queries.push(Query.equal('isInfluencer', true));
        }
        else if (targetAudience === 'Tier1' ||
            targetAudience === 'Tier2' ||
            targetAudience === 'Tier3' ||
            targetAudience === 'Tier4' ||
            targetAudience === 'Tier5') {
            const tierMap = {
                Tier1: 'NewbieSampler',
                Tier2: 'SampleFan',
                Tier3: 'SuperSampler',
                Tier4: 'VIS',
                Tier5: 'SampleMaster',
                All: '',
                NewUsers: '',
                BrandAmbassadors: '',
                Influencers: '',
                ZipCode: '',
                Targeted: '',
            };
            const tierName = tierMap[targetAudience] || '';
            if (tierName) {
                log(`Filtering by tierLevel = ${tierName}`);
                queries.push(Query.equal('tierLevel', tierName));
            }
        }
        else if (targetAudience === 'ZipCode') {
            const zips = notification?.selectedZipCodes || [];
            if (zips.length > 0) {
                log(`Filtering ZipCode audience for ${zips.length} zip(s)`);
                queries.push(Query.equal('zipCode', zips));
            }
            else {
                log('ZipCode audience selected but no zip codes provided, returning empty list');
                return [];
            }
        }
        const rawUsers = (await listAllDocuments(databases, DATABASE_ID, USER_PROFILES_TABLE_ID, queries));
        // Defense in depth: dedup by profile $id so any upstream duplicate (e.g. legacy
        // pagination, retried fetch) cannot produce duplicate push or in-app entries.
        const seen = new Set();
        const users = [];
        for (const u of rawUsers) {
            if (u && typeof u.$id === 'string' && !seen.has(u.$id)) {
                seen.add(u.$id);
                users.push(u);
            }
        }
        if (users.length !== rawUsers.length) {
            log(`Deduplicated user list: ${rawUsers.length} raw -> ${users.length} unique`);
        }
        log(`Found ${users.length} target users for audience: ${targetAudience}`);
        return users;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Error fetching users: ${errorMessage}`);
        throw new Error(`Failed to fetch target users: ${errorMessage}`);
    }
}
/**
 * Append a notification entry to a user profile's notifications array.
 * Handles both string (JSON array) and array storage formats.
 */
async function appendNotificationToUserProfile(databases, userProfileId, entry, log) {
    try {
        const doc = await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userProfileId);
        const raw = doc.notifications;
        let list = [];
        if (Array.isArray(raw)) {
            list = raw.map((item) => typeof item === 'string' ? JSON.parse(item) : item);
        }
        else if (typeof raw === 'string' && raw) {
            try {
                list = JSON.parse(raw);
            }
            catch {
                list = [];
            }
        }
        list.push(entry);
        const notificationsValue = list.map((item) => typeof item === 'string' ? item : JSON.stringify(item));
        await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userProfileId, { notifications: notificationsValue });
        log(`Appended notification to user profile ${userProfileId}`);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Warning: could not append notification to user ${userProfileId}: ${errorMessage}`);
    }
}
/**
 * Append the same notification to multiple user profiles (e.g. after sending push).
 */
async function appendNotificationToUserProfiles(databases, userProfileIds, notification, log) {
    const now = new Date().toISOString();
    const entry = {
        id: notification.$id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        isRead: false,
        createdAt: now,
        data: { notificationId: notification.$id },
    };
    for (let i = 0; i < userProfileIds.length; i += PROFILE_APPEND_CONCURRENCY) {
        const chunk = userProfileIds.slice(i, i + PROFILE_APPEND_CONCURRENCY);
        await Promise.all(chunk.map((userId) => appendNotificationToUserProfile(databases, userId, entry, log)));
    }
}
/**
 * Send a single-user system notification immediately (push + in-app profile entry),
 * bypassing the scheduled notification table flow.
 */
async function sendImmediateSystemNotificationToUser(databases, messaging, profile, title, message, type, log, data) {
    if (!profile.authID || typeof profile.authID !== 'string') {
        throw new Error('Target user profile has no valid authID');
    }
    const payload = {
        type,
        ...(data ?? {}),
    };
    const pushResult = await sendPushNotificationToUsers(messaging, [profile.authID], title, message, log, payload);
    const sentCount = pushResult.sentCount ?? 0;
    if (sentCount === 0) {
        throw new Error('Immediate push delivery failed for target user');
    }
    await appendNotificationToUserProfile(databases, profile.$id, {
        id: ID.unique(),
        type,
        title,
        message,
        isRead: false,
        createdAt: new Date().toISOString(),
        data: payload,
    }, log);
    return { success: true, sentCount };
}
const PUSH_BATCH_SIZE = 50;
const PUSH_CONCURRENCY = 3;
/** In-app profile updates run after push; parallelize to avoid serverless timeouts on large audiences. */
const PROFILE_APPEND_CONCURRENCY = 24;
/**
 * Max time to wait for in-app profile fan-out before returning HTTP success anyway.
 * Push + notification row are already updated; appends may still finish afterward.
 * Override via NOTIFICATION_APPEND_DEADLINE_MS (milliseconds).
 */
function getAppendDeadlineMs() {
    const raw = process.env.NOTIFICATION_APPEND_DEADLINE_MS;
    if (raw != null && raw !== '') {
        const n = Number(raw);
        if (!Number.isNaN(n) && n >= 1000)
            return n;
    }
    // Default keeps push + update + JSON response under common ~15s function limits.
    return 9000;
}
/**
 * Send push notification using Appwrite Messaging.
 * Uses positional createPush (node-appwrite does not accept an object as the first argument).
 * Sends to multiple users per createPush call, with concurrent batch execution.
 * users: array of Appwrite Auth user IDs (each user must have a push target registered).
 */
async function sendPushNotificationToUsers(messaging, userIds, title, body, log, data) {
    if (userIds.length === 0) {
        log('No user IDs provided for push');
        return { $id: null, status: 'skipped', sentCount: 0 };
    }
    const payload = data ?? {};
    const batches = [];
    for (let i = 0; i < userIds.length; i += PUSH_BATCH_SIZE) {
        batches.push(userIds.slice(i, i + PUSH_BATCH_SIZE));
    }
    log(`Sending push in ${batches.length} batch(es), ${userIds.length} total users`);
    let sentCount = 0;
    let failedCount = 0;
    let lastResult = null;
    let lastError = '';
    for (let i = 0; i < batches.length; i += PUSH_CONCURRENCY) {
        const chunk = batches.slice(i, i + PUSH_CONCURRENCY);
        const results = await Promise.allSettled(chunk.map((userBatch) => messaging.createPush(ID.unique(), title, body, [], userBatch, [], payload, undefined, undefined, undefined, undefined, undefined, undefined, undefined, false, undefined, undefined, undefined, undefined)));
        for (let j = 0; j < results.length; j++) {
            const settled = results[j];
            const batch = chunk[j];
            if (settled.status === 'fulfilled') {
                const result = settled.value;
                lastResult = result;
                sentCount += batch.length;
                log(`Push batch ${i + j + 1}: messageId=${result.$id}, status=${result.status}, users=${batch.length}`);
            }
            else {
                const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
                failedCount += batch.length;
                lastError = errMsg;
                log(`Failed to send push batch (${batch.length} users): ${errMsg}`);
            }
        }
    }
    log(`Push notification summary: sent=${sentCount}/${userIds.length}, failed=${failedCount}, last messageId: ${lastResult?.$id}, status: ${lastResult?.status}${lastError ? `, lastError: ${lastError}` : ''}`);
    return lastResult
        ? { ...lastResult, sentCount }
        : { $id: null, status: sentCount > 0 ? 'completed' : 'failed', sentCount };
}
/**
 * Send notification to all target users using Appwrite Messaging
 */
async function sendNotification(databases, messaging, notificationId, log) {
    try {
        // Get notification data
        log(`Fetching notification data for ID: ${notificationId}`);
        const notification = await getNotification(databases, notificationId, log);
        if (!notification) {
            throw new Error('Notification not found');
        }
        log(`Notification found: title="${notification.title}", status="${notification.status}", targetAudience="${notification.targetAudience}"`);
        if (notification.selectedUserIds && notification.selectedUserIds.length > 0) {
            log(`Selected users: ${notification.selectedUserIds.length} user(s)`);
        }
        if (notification.status === 'Sent') {
            log('Notification already sent - skipping');
            return {
                success: true,
                recipients: notification.recipients || 0,
            };
        }
        // Get target users
        const users = await getTargetUsers(databases, notification.targetAudience, notification.selectedUserIds, log, notification);
        if (users.length === 0) {
            log('No target users found');
            // Update notification status even if no users
            await databases.updateDocument(DATABASE_ID, NOTIFICATIONS_TABLE_ID, notificationId, {
                status: 'Sent',
                sentAt: new Date().toISOString(),
                recipients: 0,
            });
            return {
                success: true,
                recipients: 0,
            };
        }
        // Extract user auth IDs for push notification.
        // Dedup so that if two user_profiles rows share an authID (data-integrity edge case)
        // the user still gets the push exactly once.
        const userAuthIds = Array.from(new Set(users
            .map((user) => user.authID)
            .filter((id) => typeof id === 'string' && id.length > 0)));
        if (userAuthIds.length === 0) {
            log(`ERROR: Found ${users.length} user profile(s) but none have a valid authID. Push cannot be sent.`);
            return {
                success: false,
                recipients: 0,
                error: `Found ${users.length} user profile(s) but none have a valid authID linked. Push notifications require users to have an authenticated account.`,
            };
        }
        log(`Preparing to send push notification to ${userAuthIds.length} users`);
        log(`User auth IDs: ${userAuthIds.slice(0, 5).join(', ')}${userAuthIds.length > 5 ? '...' : ''}`);
        // Send push notification using Appwrite Messaging
        const pushResult = await sendPushNotificationToUsers(messaging, userAuthIds, notification.title, notification.message, log, {
            notificationId: notification.$id,
            type: notification.type,
        });
        const recipientCount = pushResult.sentCount ?? userAuthIds.length;
        log(`Push result: ID=${pushResult.$id}, status=${pushResult.status}, sentCount=${recipientCount}`);
        if (recipientCount === 0 && userAuthIds.length > 0) {
            log(`ERROR: All push batches failed. ${userAuthIds.length} users targeted but 0 reached. Notification will NOT be marked as Sent.`);
            await databases.updateDocument(DATABASE_ID, NOTIFICATIONS_TABLE_ID, notificationId, { status: 'Draft' });
            return {
                success: false,
                recipients: 0,
                error: `Push delivery failed for all ${userAuthIds.length} targeted users. The notification remains in Draft status. Check that Appwrite Messaging has a push provider (FCM/APNS) configured and that users have registered push targets.`,
            };
        }
        // Update notification status
        const now = new Date().toISOString();
        await databases.updateDocument(DATABASE_ID, NOTIFICATIONS_TABLE_ID, notificationId, {
            status: 'Sent',
            sentAt: now,
            recipients: recipientCount,
        });
        // In-app list fan-out: many DB round-trips; can exceed the function HTTP timeout if we block on all users.
        // Push and notifications row are already "Sent" — return a response before the platform kills the execution.
        const userProfileIds = users.map((u) => u.$id);
        const appendPromise = appendNotificationToUserProfiles(databases, userProfileIds, notification, log);
        const deadlineMs = getAppendDeadlineMs();
        try {
            await Promise.race([
                appendPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`In-app append still running after ${deadlineMs}ms (non-fatal; push already delivered)`)), deadlineMs)),
            ]);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log(`Warning: ${msg}`);
        }
        log(`Notification sent successfully. Recipients: ${recipientCount}, Message ID: ${pushResult.$id}`);
        return {
            success: true,
            recipients: recipientCount,
            messageId: pushResult.$id ?? undefined,
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Error sending notification: ${errorMessage}`);
        throw error instanceof Error ? error : new Error(errorMessage);
    }
}
/**
 * Check and send event reminders
 * This function runs on a schedule to check for events that need reminders
 * and sends push notifications to users who have saved those events
 *
 * NEW: Uses user-level reminder tracking instead of event-level tracking
 * This allows users who save events late to still receive remaining reminders
 */
async function checkAndSendEventReminders(databases, messaging, log) {
    try {
        log('Starting event reminder check with user-level tracking...');
        const now = new Date();
        const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const in1Hour = new Date(now.getTime() + 60 * 60 * 1000);
        // Define time windows for checking (±15 minutes for flexibility)
        const time24hStart = new Date(in24Hours.getTime() - 15 * 60 * 1000);
        const time24hEnd = new Date(in24Hours.getTime() + 15 * 60 * 1000);
        const time1hStart = new Date(in1Hour.getTime() - 15 * 60 * 1000);
        const time1hEnd = new Date(in1Hour.getTime() + 15 * 60 * 1000);
        log(`Checking for events at ${now.toISOString()}`);
        log(`24h window: ${time24hStart.toISOString()} to ${time24hEnd.toISOString()}`);
        log(`1h window: ${time1hStart.toISOString()} to ${time1hEnd.toISOString()}`);
        // Fetch all events
        const events = (await listAllDocuments(databases, DATABASE_ID, EVENTS_TABLE_ID, []));
        log(`Found ${events.length} total events`);
        // Index events by ID and cache the parsed start instant. We deliberately do NOT fall
        // back to event.date (midnight UTC of the event day) because that anchors reminders to
        // midnight and produces "starts in 1 hour" pushes at 11pm the day before for any event
        // whose true start time was never set. If startTime is missing or unparseable, skip
        // the event entirely so the issue surfaces in logs instead of as a wrong-time push.
        const eventStartInstantById = new Map();
        const eventsMap = new Map();
        const events24h = [];
        const events1h = [];
        let eventsSkippedMissingStart = 0;
        for (const event of events) {
            eventsMap.set(event.$id, event);
            if (!event.startTime) {
                eventsSkippedMissingStart++;
                log(`Skipping event ${event.$id} "${event.name}": missing startTime (date=${event.date ?? 'n/a'})`);
                continue;
            }
            const eventDate = new Date(event.startTime);
            if (Number.isNaN(eventDate.getTime())) {
                eventsSkippedMissingStart++;
                log(`Skipping event ${event.$id} "${event.name}": unparseable startTime="${event.startTime}"`);
                continue;
            }
            eventStartInstantById.set(event.$id, eventDate);
            if (eventDate >= time24hStart && eventDate <= time24hEnd) {
                events24h.push(event);
            }
            // Check if event is in 1h window
            if (eventDate >= time1hStart && eventDate <= time1hEnd) {
                events1h.push(event);
            }
        }
        log(`Events in 24h window: ${events24h.length}, in 1h window: ${events1h.length}, skipped (missing/invalid startTime): ${eventsSkippedMissingStart}`);
        // Fetch all users
        const allUsers = (await listAllDocuments(databases, DATABASE_ID, USER_PROFILES_TABLE_ID, []));
        log(`Checking ${allUsers.length} users for saved events`);
        let reminders24hSent = 0;
        let reminders1hSent = 0;
        // Process each user
        for (const user of allUsers) {
            try {
                if (!user.savedEventIds || !user.authID) {
                    continue;
                }
                let savedEvents = [];
                try {
                    savedEvents = JSON.parse(user.savedEventIds);
                }
                catch {
                    log(`Error parsing savedEventIds for user ${user.$id}`);
                    continue;
                }
                let needsUpdate = false;
                // Check each saved event
                for (const savedEvent of savedEvents) {
                    const event = eventsMap.get(savedEvent.eventId);
                    if (!event)
                        continue;
                    const eventDate = eventStartInstantById.get(savedEvent.eventId);
                    if (!eventDate)
                        continue; // event was skipped above (no valid startTime)
                    // Check if user needs 24h reminder for this event
                    if (eventDate >= time24hStart &&
                        eventDate <= time24hEnd &&
                        !savedEvent.reminder24hSent) {
                        const deltaMs = eventDate.getTime() - now.getTime();
                        log(`[24h fire] user=${user.$id} event=${event.$id} startTime=${event.startTime} now=${now.toISOString()} deltaMs=${deltaMs}`);
                        // Send push notification
                        await sendPushNotificationToUsers(messaging, [user.authID], `Event Reminder: ${event.name}`, `Your saved event "${event.name}" starts in 24 hours! Location: ${event.address}, ${event.city}`, log, {
                            eventId: event.$id,
                            reminderType: '24h',
                            type: 'Event Reminder',
                        });
                        await appendNotificationToUserProfile(databases, user.$id, {
                            id: ID.unique(),
                            type: 'Event Reminder',
                            title: `Event Reminder: ${event.name}`,
                            message: `Your saved event "${event.name}" starts in 24 hours! Location: ${event.address}, ${event.city}`,
                            isRead: false,
                            createdAt: new Date().toISOString(),
                            data: { eventId: event.$id, reminderType: '24h', type: 'Event Reminder' },
                        }, log);
                        // Mark as sent in the savedEvent object
                        savedEvent.reminder24hSent = true;
                        needsUpdate = true;
                        reminders24hSent++;
                    }
                    // Check if user needs 1h reminder for this event
                    if (eventDate >= time1hStart &&
                        eventDate <= time1hEnd &&
                        !savedEvent.reminder1hSent) {
                        const deltaMs = eventDate.getTime() - now.getTime();
                        log(`[1h fire] user=${user.$id} event=${event.$id} startTime=${event.startTime} now=${now.toISOString()} deltaMs=${deltaMs}`);
                        // Send push notification
                        await sendPushNotificationToUsers(messaging, [user.authID], `Event Reminder: ${event.name}`, `Your saved event "${event.name}" starts in 1 hour! Location: ${event.address}, ${event.city}`, log, {
                            eventId: event.$id,
                            reminderType: '1h',
                            type: 'Event Reminder',
                        });
                        await appendNotificationToUserProfile(databases, user.$id, {
                            id: ID.unique(),
                            type: 'Event Reminder',
                            title: `Event Reminder: ${event.name}`,
                            message: `Your saved event "${event.name}" starts in 1 hour! Location: ${event.address}, ${event.city}`,
                            isRead: false,
                            createdAt: new Date().toISOString(),
                            data: { eventId: event.$id, reminderType: '1h', type: 'Event Reminder' },
                        }, log);
                        // Mark as sent in the savedEvent object
                        savedEvent.reminder1hSent = true;
                        needsUpdate = true;
                        reminders1hSent++;
                    }
                }
                // Update user's savedEventIds if any reminders were sent
                if (needsUpdate) {
                    await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, user.$id, {
                        savedEventIds: JSON.stringify(savedEvents),
                    });
                    log(`Updated reminder flags for user ${user.$id}`);
                }
            }
            catch (userError) {
                const errorMessage = userError instanceof Error ? userError.message : String(userError);
                log(`Error processing user ${user.$id}: ${errorMessage}`);
                // Continue with next user
            }
        }
        log(`Reminder check complete. 24h reminders: ${reminders24hSent}, 1h reminders: ${reminders1hSent}`);
        return {
            success: true,
            reminders24h: reminders24hSent,
            reminders1h: reminders1hSent,
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Error checking event reminders: ${errorMessage}`);
        throw error instanceof Error ? error : new Error(errorMessage);
    }
}
/**
 * Check for scheduled notifications that are due and send them.
 * Runs on the same cron schedule as event reminders (every 15 minutes).
 * Notifications with status 'Scheduled' and scheduledAt <= now are sent to their target users.
 */
async function checkAndSendScheduledNotifications(databases, messaging, log) {
    try {
        const now = new Date();
        const nowISO = now.toISOString();
        // Server runs in UTC; log for debugging timezone issues
        log(`Server time: ${nowISO} UTC (tz: ${process.env.TZ ?? 'UTC'})`);
        log(`Checking for due scheduled notifications (scheduledAt <= ${nowISO})`);
        const dueNotifications = (await listAllDocuments(databases, DATABASE_ID, NOTIFICATIONS_TABLE_ID, [
            Query.equal('status', 'Scheduled'),
            Query.lessThanEqual('scheduledAt', nowISO),
        ]));
        log(`Found ${dueNotifications.length} scheduled notification(s) due to send`);
        let sent = 0;
        let failed = 0;
        for (const notification of dueNotifications) {
            try {
                log(`Sending scheduled notification: ${notification.$id} "${notification.title}"`);
                await sendNotification(databases, messaging, notification.$id, log);
                sent += 1;
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log(`Failed to send scheduled notification ${notification.$id}: ${errMsg}`);
                failed += 1;
            }
        }
        log(`Scheduled notifications check complete. Sent: ${sent}, Failed: ${failed}`);
        return { success: true, sent, failed };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Error checking scheduled notifications: ${errorMessage}`);
        throw error instanceof Error ? error : new Error(errorMessage);
    }
}
// ============================================================================
// SETTINGS HELPERS
// ============================================================================
async function getSettingValue(databases, key) {
    try {
        const result = await databases.listDocuments(DATABASE_ID, SETTINGS_TABLE_ID, [Query.equal('key', key), Query.limit(1)]);
        if (result.documents.length > 0) {
            return result.documents[0].value;
        }
        return null;
    }
    catch {
        return null;
    }
}
async function setSettingValue(databases, key, value) {
    const result = await databases.listDocuments(DATABASE_ID, SETTINGS_TABLE_ID, [Query.equal('key', key), Query.limit(1)]);
    if (result.documents.length > 0) {
        await databases.updateDocument(DATABASE_ID, SETTINGS_TABLE_ID, result.documents[0].$id, { value });
    }
    else {
        await databases.createDocument(DATABASE_ID, SETTINGS_TABLE_ID, ID.unique(), {
            key,
            value,
        });
    }
}
// ============================================================================
// AUTOMATED NOTIFICATION CHECKS
// ============================================================================
/**
 * TRIVIA TUESDAY
 * Sends "Earn points by knowing fun facts about your favorite brands!" to all users
 * every Tuesday morning. Uses settings key `triviaTuesdayLastSent` to run once per Tuesday.
 */
async function checkAndSendTriviaTuesday(databases, messaging, log) {
    const now = new Date();
    if (!isTuesdayEastern(now)) {
        log('Trivia Tuesday: not Tuesday (America/New_York), skipping');
        return { sent: 0 };
    }
    const todayStr = getEasternDateString(now);
    const lastSent = await getSettingValue(databases, 'triviaTuesdayLastSent');
    if (lastSent === todayStr) {
        log('Trivia Tuesday: already sent this Eastern date, skipping');
        return { sent: 0 };
    }
    log('Trivia Tuesday: sending to all users');
    const allUsers = (await listAllDocuments(databases, DATABASE_ID, USER_PROFILES_TABLE_ID, []));
    const authIds = allUsers
        .map((u) => u.authID)
        .filter((id) => id && typeof id === 'string');
    const result = await sendPushNotificationToUsers(messaging, authIds, 'TRIVIA TUESDAY', 'Earn points by knowing fun facts about your favorite brands!', log, { type: 'Engagement' });
    const sentCount = result.sentCount ?? 0;
    if (sentCount > 0) {
        await setSettingValue(databases, 'triviaTuesdayLastSent', todayStr);
        for (const user of allUsers) {
            if (!user.authID)
                continue;
            try {
                await appendNotificationToUserProfile(databases, user.$id, {
                    id: ID.unique(),
                    type: 'Engagement',
                    title: 'TRIVIA TUESDAY',
                    message: 'Earn points by knowing fun facts about your favorite brands!',
                    isRead: false,
                    createdAt: new Date().toISOString(),
                    data: { type: 'Engagement' },
                }, log);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`Trivia Tuesday: failed to append in-app notification for user ${user.$id}: ${msg}`);
            }
        }
    }
    log(`Trivia Tuesday: sent to ${sentCount} users`);
    return { sent: result.sentCount ?? 0 };
}
/**
 * SAMPLING TODAY
 * Sends "Sampling at {storeName} starts at {time}!" the morning of the event
 * to users who have that event in their savedEventIds calendar.
 * Tracks `samplingTodaySent` flag per saved event entry to avoid resending.
 */
async function checkAndSendSamplingToday(databases, messaging, log) {
    const now = new Date();
    const todayStr = getEasternDateString(now);
    log(`Sampling Today: checking for events on ${todayStr} (America/New_York)`);
    const allEvents = (await listAllDocuments(databases, DATABASE_ID, EVENTS_TABLE_ID, []));
    const todaysEvents = allEvents.filter((e) => {
        if (e.isArchived || e.isHidden)
            return false;
        const start = new Date(e.startTime || e.date || '');
        if (Number.isNaN(start.getTime()))
            return false;
        return getEasternDateString(start) === todayStr;
    });
    if (todaysEvents.length === 0) {
        log('Sampling Today: no events today');
        return { sent: 0 };
    }
    log(`Sampling Today: ${todaysEvents.length} event(s) today`);
    const todaysEventIds = new Set(todaysEvents.map((e) => e.$id));
    const eventsMap = new Map(todaysEvents.map((e) => [e.$id, e]));
    const allUsers = (await listAllDocuments(databases, DATABASE_ID, USER_PROFILES_TABLE_ID, []));
    let totalSent = 0;
    for (const user of allUsers) {
        if (!user.savedEventIds || !user.authID)
            continue;
        let savedEvents;
        try {
            savedEvents = JSON.parse(user.savedEventIds);
        }
        catch {
            continue;
        }
        let needsUpdate = false;
        for (const saved of savedEvents) {
            if (!todaysEventIds.has(saved.eventId) ||
                saved.samplingTodaySent) {
                continue;
            }
            const event = eventsMap.get(saved.eventId);
            if (!event)
                continue;
            const startDate = new Date(event.startTime || event.date);
            const timeStr = startDate.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
                timeZone: EST_TIMEZONE,
            });
            const storeName = event.name || 'your event';
            const pushResult = await sendPushNotificationToUsers(messaging, [user.authID], 'SAMPLING TODAY', `Sampling at ${storeName} starts at ${timeStr}! Click to learn more!`, log, { eventId: event.$id, type: 'Event Reminder' });
            if ((pushResult.sentCount ?? 0) === 0) {
                log(`Sampling Today: push delivery failed for user ${user.$id}, not marking as sent`);
                continue;
            }
            await appendNotificationToUserProfile(databases, user.$id, {
                id: ID.unique(),
                type: 'Event Reminder',
                title: 'SAMPLING TODAY',
                message: `Sampling at ${storeName} starts at ${timeStr}! Click to learn more!`,
                isRead: false,
                createdAt: new Date().toISOString(),
                data: { eventId: event.$id, type: 'Event Reminder' },
            }, log);
            saved.samplingTodaySent = true;
            needsUpdate = true;
            totalSent++;
        }
        if (needsUpdate) {
            try {
                await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, user.$id, { savedEventIds: JSON.stringify(savedEvents) });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`Sampling Today: failed to update flags for user ${user.$id}: ${msg}`);
            }
        }
    }
    log(`Sampling Today: sent ${totalSent} notification(s)`);
    return { sent: totalSent };
}
const NEARBY_MAX_MILES = 50;
const NEARBY_MAX_DAYS = 7;
const EARTH_RADIUS_MILES = 3958.8;
function haversineMiles(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_MILES * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function getEventLatLng(e) {
    const loc = e.location;
    if (!loc)
        return null;
    if (Array.isArray(loc) && loc.length >= 2) {
        const a = Number(loc[0]);
        const b = Number(loc[1]);
        if (Number.isNaN(a) || Number.isNaN(b))
            return null;
        return { lng: a, lat: b };
    }
    if (typeof loc === 'object' && loc !== null && 'coordinates' in loc) {
        const c = loc.coordinates;
        if (Array.isArray(c) && c.length >= 2) {
            return { lng: c[0], lat: c[1] };
        }
    }
    return null;
}
function getEventClientId(e) {
    const c = e.client;
    if (!c)
        return null;
    if (typeof c === 'string')
        return c;
    if (typeof c === 'object' && c !== null && '$id' in c)
        return c.$id;
    return null;
}
async function geocodeUsZip(zip) {
    const cleaned = zip.replace(/\D/g, '').slice(0, 5);
    if (cleaned.length !== 5)
        return null;
    try {
        const res = await fetch(`https://api.zippopotam.us/us/${cleaned}`);
        if (!res.ok)
            return null;
        const data = (await res.json());
        const p = data.places?.[0];
        if (!p)
            return null;
        return { lat: parseFloat(p.latitude), lng: parseFloat(p.longitude) };
    }
    catch {
        return null;
    }
}
function parseNearbyNotifiedIds(raw) {
    if (!raw || typeof raw !== 'string')
        return [];
    try {
        const p = JSON.parse(raw);
        return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : [];
    }
    catch {
        return [];
    }
}
async function resolveUserLatLng(databases, user, log) {
    const hLat = user.homeLatitude;
    const hLng = user.homeLongitude;
    if (typeof hLat === 'number' && typeof hLng === 'number' && !Number.isNaN(hLat) && !Number.isNaN(hLng)) {
        return { lat: hLat, lng: hLng };
    }
    const zLat = user.zipGeoLat;
    const zLng = user.zipGeoLng;
    if (typeof zLat === 'number' && typeof zLng === 'number' && !Number.isNaN(zLat) && !Number.isNaN(zLng)) {
        return { lat: zLat, lng: zLng };
    }
    const zip = typeof user.zipCode === 'string' ? user.zipCode.trim() : '';
    if (!zip)
        return null;
    const geo = await geocodeUsZip(zip);
    if (geo) {
        try {
            await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, user.$id, {
                zipGeoLat: geo.lat,
                zipGeoLng: geo.lng,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Nearby favorite: could not cache zip geocode for user ${user.$id}: ${msg}`);
        }
    }
    return geo;
}
/**
 * NEW SAMPLING EVENT NEAR YOU
 * Favorite brand has an event in the next 7 days within 50 miles of the user's zip/home.
 */
async function checkAndSendNearbyFavoriteSampling(databases, messaging, log) {
    const now = new Date();
    const horizon = new Date(now.getTime() + NEARBY_MAX_DAYS * 24 * 60 * 60 * 1000);
    const allEvents = (await listAllDocuments(databases, DATABASE_ID, EVENTS_TABLE_ID, []));
    const upcoming = allEvents.filter((e) => {
        if (e.isArchived || e.isHidden)
            return false;
        const start = new Date(e.startTime || e.date || '');
        if (Number.isNaN(start.getTime()))
            return false;
        return start >= now && start <= horizon;
    });
    if (upcoming.length === 0) {
        log('Nearby favorite: no upcoming events in window');
        return { sent: 0 };
    }
    const clientNameCache = new Map();
    async function getBrandName(clientId) {
        if (clientNameCache.has(clientId)) {
            return clientNameCache.get(clientId) ?? 'A brand';
        }
        try {
            const doc = await databases.getDocument(DATABASE_ID, CLIENTS_TABLE_ID, clientId);
            const row = doc;
            const name = (row.title || row.name || 'A brand').trim();
            clientNameCache.set(clientId, name);
            return name;
        }
        catch {
            clientNameCache.set(clientId, 'A brand');
            return 'A brand';
        }
    }
    const allUsers = (await listAllDocuments(databases, DATABASE_ID, USER_PROFILES_TABLE_ID, []));
    let totalSent = 0;
    for (const user of allUsers) {
        if (!user.authID)
            continue;
        const favRaw = user.favoriteIds;
        const favorites = Array.isArray(favRaw)
            ? favRaw.filter((x) => typeof x === 'string')
            : [];
        if (favorites.length === 0)
            continue;
        const userPos = await resolveUserLatLng(databases, user, log);
        if (!userPos) {
            continue;
        }
        let notified = parseNearbyNotifiedIds(user.nearbyFavoriteNotifiedEventIds);
        let needsProfileUpdate = false;
        for (const event of upcoming) {
            const clientId = getEventClientId(event);
            if (!clientId || !favorites.includes(clientId))
                continue;
            const evPos = getEventLatLng(event);
            if (!evPos)
                continue;
            const miles = haversineMiles(userPos.lat, userPos.lng, evPos.lat, evPos.lng);
            if (miles > NEARBY_MAX_MILES)
                continue;
            if (notified.includes(event.$id))
                continue;
            const brandName = await getBrandName(clientId);
            const pushResult = await sendPushNotificationToUsers(messaging, [user.authID], 'NEW SAMPLING EVENT NEAR YOU', `Heads up, ${brandName} has a sampling event coming up near you. Click to learn more!`, log, { eventId: event.$id, type: 'Promotional' });
            if ((pushResult.sentCount ?? 0) === 0) {
                log(`Nearby favorite: push failed for user ${user.$id} event ${event.$id}`);
                continue;
            }
            await appendNotificationToUserProfile(databases, user.$id, {
                id: ID.unique(),
                type: 'Promotional',
                title: 'NEW SAMPLING EVENT NEAR YOU',
                message: `Heads up, ${brandName} has a sampling event coming up near you. Click to learn more!`,
                isRead: false,
                createdAt: new Date().toISOString(),
                data: { eventId: event.$id, type: 'Promotional' },
            }, log);
            notified = [...notified, event.$id];
            needsProfileUpdate = true;
            totalSent++;
        }
        if (needsProfileUpdate) {
            const trimmed = notified.slice(-500);
            try {
                await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, user.$id, {
                    nearbyFavoriteNotifiedEventIds: JSON.stringify(trimmed),
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`Nearby favorite: failed to save notified ids for ${user.$id}: ${msg}`);
            }
        }
    }
    log(`Nearby favorite: sent ${totalSent} notification(s)`);
    return { sent: totalSent };
}
/**
 * HAPPY BIRTHDAY
 * Sends birthday push + awards configurable points on the user's birthday.
 * Uses `birthdayNotifYear` to send once per year.
 */
async function checkAndSendBirthdayNotifications(databases, messaging, log) {
    const now = new Date();
    const todayEastern = getEasternDateString(now);
    const lastRun = await getSettingValue(databases, 'birthdayCheckLastRun');
    if (lastRun === todayEastern) {
        log('Birthday: already checked this Eastern calendar day, skipping');
        return { sent: 0 };
    }
    const todayParts = getTimePartsInTimezone(now, EST_TIMEZONE);
    const currentYear = todayParts.year;
    const currentMonth = todayParts.month;
    const currentDay = todayParts.day;
    const pointsStr = await getSettingValue(databases, 'birthdayPoints');
    const points = pointsStr ? parseInt(pointsStr, 10) : 100;
    log(`Birthday: checking for birthdays on ${currentMonth}/${currentDay} (${EST_TIMEZONE}), awarding ${points} points`);
    const allUsers = (await listAllDocuments(databases, DATABASE_ID, USER_PROFILES_TABLE_ID, []));
    let sent = 0;
    for (const user of allUsers) {
        if (!user.dob || !user.authID)
            continue;
        if (user.birthdayNotifYear === currentYear)
            continue;
        // DOB is a calendar date pinned to UTC midnight (e.g. "1988-08-07T00:00:00.000Z").
        // Read the calendar M/D from the ISO prefix directly — converting to EST would roll
        // the day back (UTC midnight Aug 7 → Aug 6 evening EST), firing birthdays one day early.
        const dobMatch = user.dob.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (!dobMatch)
            continue;
        const dobMonth = parseInt(dobMatch[2], 10);
        const dobDay = parseInt(dobMatch[3], 10);
        if (dobMonth !== currentMonth || dobDay !== currentDay)
            continue;
        log(`Birthday: sending to user ${user.$id}`);
        const pushResult = await sendPushNotificationToUsers(messaging, [user.authID], 'HAPPY BIRTHDAY!', `We wish you a very happy birthday, from all of us here at SampleFinder! As a gift, we've awarded you ${points} points.`, log, { type: 'Engagement' });
        if ((pushResult.sentCount ?? 0) === 0) {
            log(`Birthday: push delivery failed for user ${user.$id}, skipping yearly flag/points update`);
            continue;
        }
        await appendNotificationToUserProfile(databases, user.$id, {
            id: ID.unique(),
            type: 'Engagement',
            title: 'HAPPY BIRTHDAY!',
            message: `We wish you a very happy birthday, from all of us here at SampleFinder! As a gift, we've awarded you ${points} points.`,
            isRead: false,
            createdAt: new Date().toISOString(),
            data: { type: 'Engagement' },
        }, log);
        const currentPoints = user.totalPoints ?? 0;
        try {
            await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, user.$id, {
                birthdayNotifYear: currentYear,
                totalPoints: currentPoints + points,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Birthday: failed to update user ${user.$id}: ${msg}`);
        }
        sent++;
    }
    await setSettingValue(databases, 'birthdayCheckLastRun', todayEastern);
    log(`Birthday: sent ${sent} notification(s)`);
    return { sent };
}
/**
 * HAPPY SAMPLING ANNIVERSARY
 * Sends anniversary push + awards configurable points on the user's join date anniversary.
 * Uses `anniversaryNotifYear` to send once per year. Only triggers after at least 1 full year.
 */
async function checkAndSendAnniversaryNotifications(databases, messaging, log) {
    const now = new Date();
    const todayEastern = getEasternDateString(now);
    const lastRun = await getSettingValue(databases, 'anniversaryCheckLastRun');
    if (lastRun === todayEastern) {
        log('Anniversary: already checked this Eastern calendar day, skipping');
        return { sent: 0 };
    }
    const todayParts = getTimePartsInTimezone(now, EST_TIMEZONE);
    const currentYear = todayParts.year;
    const currentMonth = todayParts.month;
    const currentDay = todayParts.day;
    const pointsStr = await getSettingValue(databases, 'anniversaryPoints');
    const points = pointsStr ? parseInt(pointsStr, 10) : 200;
    log(`Anniversary: checking for join-date anniversaries on ${currentMonth}/${currentDay} (${EST_TIMEZONE}), awarding ${points} points`);
    const allUsers = (await listAllDocuments(databases, DATABASE_ID, USER_PROFILES_TABLE_ID, []));
    let sent = 0;
    for (const user of allUsers) {
        if (!user.$createdAt || !user.authID)
            continue;
        if (user.anniversaryNotifYear === currentYear)
            continue;
        const createdAt = new Date(user.$createdAt);
        if (Number.isNaN(createdAt.getTime()))
            continue;
        const createdParts = getTimePartsInTimezone(createdAt, EST_TIMEZONE);
        if (createdParts.month !== currentMonth || createdParts.day !== currentDay)
            continue;
        const yearsOnPlatform = currentYear - createdParts.year;
        if (yearsOnPlatform < 1)
            continue;
        log(`Anniversary: sending to user ${user.$id} (${yearsOnPlatform} year(s))`);
        const pushResult = await sendPushNotificationToUsers(messaging, [user.authID], 'HAPPY SAMPLING ANNIVERSARY!', `Congratulations on reaching a full new year of sampling with SampleFinder! As a gift, we've awarded you ${points} points.`, log, { type: 'Engagement' });
        if ((pushResult.sentCount ?? 0) === 0) {
            log(`Anniversary: push delivery failed for user ${user.$id}, skipping yearly flag/points update`);
            continue;
        }
        await appendNotificationToUserProfile(databases, user.$id, {
            id: ID.unique(),
            type: 'Engagement',
            title: 'HAPPY SAMPLING ANNIVERSARY!',
            message: `Congratulations on reaching a full new year of sampling with SampleFinder! As a gift, we've awarded you ${points} points.`,
            isRead: false,
            createdAt: new Date().toISOString(),
            data: { type: 'Engagement' },
        }, log);
        const currentPoints = user.totalPoints ?? 0;
        try {
            await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, user.$id, {
                anniversaryNotifYear: currentYear,
                totalPoints: currentPoints + points,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Anniversary: failed to update user ${user.$id}: ${msg}`);
        }
        sent++;
    }
    await setSettingValue(databases, 'anniversaryCheckLastRun', todayEastern);
    log(`Anniversary: sent ${sent} notification(s)`);
    return { sent };
}
/**
 * YOU'VE BEEN MISSING SAMPLES
 * Sends re-engagement push to users who haven't logged in for 30+ days.
 * Re-sends every 30 days of continued inactivity using `lastInactivityNotifAt`.
 */
async function checkAndSendInactivityNotifications(databases, messaging, users, log) {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const lastRun = await getSettingValue(databases, 'inactivityCheckLastRun');
    if (lastRun === todayStr) {
        log('Inactivity: already checked today, skipping');
        return { sent: 0 };
    }
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(now.getTime() - thirtyDaysMs);
    log(`Inactivity: checking for users inactive since before ${cutoffDate.toISOString()}`);
    const allProfiles = (await listAllDocuments(databases, DATABASE_ID, USER_PROFILES_TABLE_ID, []));
    const AUTH_BATCH_SIZE = 50;
    let sent = 0;
    for (let i = 0; i < allProfiles.length; i += AUTH_BATCH_SIZE) {
        const batch = allProfiles.slice(i, i + AUTH_BATCH_SIZE);
        const authIds = batch.map((u) => u.authID).filter(Boolean);
        if (authIds.length === 0)
            continue;
        let authUsersMap;
        try {
            const authResult = await users.list([
                Query.equal('$id', authIds),
                Query.limit(AUTH_BATCH_SIZE),
            ]);
            authUsersMap = new Map(authResult.users.map((au) => [au.$id, { accessedAt: au.accessedAt }]));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Inactivity: failed to fetch auth users batch: ${msg}`);
            continue;
        }
        for (const profile of batch) {
            if (!profile.authID)
                continue;
            const authUser = authUsersMap.get(profile.authID);
            if (!authUser?.accessedAt)
                continue;
            const lastAccess = new Date(authUser.accessedAt);
            if (lastAccess >= cutoffDate)
                continue;
            if (profile.lastInactivityNotifAt) {
                const lastNotif = new Date(profile.lastInactivityNotifAt);
                if (now.getTime() - lastNotif.getTime() < thirtyDaysMs)
                    continue;
            }
            log(`Inactivity: sending to user ${profile.$id} (last access: ${authUser.accessedAt})`);
            const pushResult = await sendPushNotificationToUsers(messaging, [profile.authID], "YOU'VE BEEN MISSING SAMPLES!", 'Enjoy experiencing new brands, earning points and winning prizes!', log, { type: 'Engagement' });
            if ((pushResult.sentCount ?? 0) === 0) {
                log(`Inactivity: push delivery failed for user ${profile.$id}, not updating inactivity marker`);
                continue;
            }
            await appendNotificationToUserProfile(databases, profile.$id, {
                id: ID.unique(),
                type: 'Engagement',
                title: "YOU'VE BEEN MISSING SAMPLES!",
                message: 'Enjoy experiencing new brands, earning points and winning prizes!',
                isRead: false,
                createdAt: new Date().toISOString(),
                data: { type: 'Engagement' },
            }, log);
            try {
                await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, profile.$id, { lastInactivityNotifAt: now.toISOString() });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`Inactivity: failed to update user ${profile.$id}: ${msg}`);
            }
            sent++;
        }
    }
    await setSettingValue(databases, 'inactivityCheckLastRun', todayStr);
    log(`Inactivity: sent ${sent} notification(s)`);
    return { sent };
}
/**
 * BADGE EARNED NOTIFICATION
 * Sends a push notification when an admin assigns ambassador or influencer badge.
 * Called via POST /send-badge-notification.
 *
 * Title/message/type intentionally match the client's `syncSpecialBadgeAwards` output
 * so the mobile app treats this as the single source of truth for the badge notification
 * (mobile push handler skips persisting `badgeEarned` pushes, and the client sync uses
 * this unread notification instead of creating a duplicate in-app entry).
 */
async function sendBadgeNotification(databases, messaging, userId, badgeType, log) {
    log(`Badge notification: sending ${badgeType} badge notification for auth user ${userId}`);
    const title = badgeType === 'ambassador'
        ? 'NEW BADGE: CERTIFIED BRAND AMBASSADOR'
        : 'NEW BADGE: CERTIFIED INFLUENCER';
    const body = badgeType === 'ambassador'
        ? 'Congratulations! You earned the Certified Brand Ambassador badge.'
        : 'Congratulations! You earned the Certified Influencer badge.';
    const profileResult = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('authID', userId), Query.limit(1)]);
    if (profileResult.documents.length === 0) {
        throw new Error('Badge notification target profile not found');
    }
    const profile = profileResult.documents[0];
    return await sendImmediateSystemNotificationToUser(databases, messaging, profile, title, body, 'badgeEarned', log, {
        badgeType,
        isSpecialBadge: 'true',
        pointsEarned: '100',
        screen: 'Profile',
    });
}
/**
 * TIER CHANGED NOTIFICATION
 * Sends a push notification when a user's tier changes (e.g. via admin panel).
 * Called via POST /send-tier-notification.
 */
async function sendTierNotification(databases, messaging, userId, newTierName, oldTierName, log) {
    log(`Tier notification: sending tierChanged notification for auth user ${userId}`);
    const title = `NEW TIER: ${newTierName}!`;
    const body = `Congratulations, you've reached the ${newTierName} tier! Keep earning points to level up!`;
    const profileResult = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('authID', userId), Query.limit(1)]);
    if (profileResult.documents.length === 0) {
        throw new Error('Tier notification target profile not found');
    }
    const profile = profileResult.documents[0];
    return await sendImmediateSystemNotificationToUser(databases, messaging, profile, title, body, 'Engagement', log, {
        oldTierName: oldTierName ?? '',
        newTierName,
    });
}
/**
 * REFERRAL POINTS EARNED NOTIFICATION
 * Sends a push notification when a user earns referral points.
 * Called via POST /send-referral-points-notification.
 */
async function sendReferralPointsNotification(databases, messaging, userId, points, log) {
    log(`Referral notification: sending referral points notification for auth user ${userId}`);
    const normalizedPoints = typeof points === 'number' && points > 0 ? Math.floor(points) : undefined;
    const title = 'REFERRAL POINTS EARNED';
    const body = normalizedPoints
        ? `A new user signed up using your referral code! You earned ${normalizedPoints} points. Thank you for sharing!`
        : 'A new user signed up using your referral code! Thank you for sharing!';
    const profileResult = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('authID', userId), Query.limit(1)]);
    if (profileResult.documents.length === 0) {
        throw new Error('Referral notification target profile not found');
    }
    const profile = profileResult.documents[0];
    return await sendImmediateSystemNotificationToUser(databases, messaging, profile, title, body, 'Engagement', log, normalizedPoints ? { points: String(normalizedPoints) } : undefined);
}
/**
 * Archive events that completed more than 7 days ago (endTime < now - 7 days).
 * Runs on the same cron schedule as event reminders and scheduled notifications.
 */
async function archiveEventsCompletedOver7DaysAgo(databases, log) {
    try {
        const now = new Date();
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoISO = sevenDaysAgo.toISOString();
        log(`Checking for events to auto-archive (endTime < ${sevenDaysAgoISO})`);
        const response = await databases.listDocuments(DATABASE_ID, EVENTS_TABLE_ID, [
            Query.equal('isArchived', false),
            Query.lessThan('endTime', sevenDaysAgoISO),
            Query.limit(500),
        ]);
        let archived = 0;
        for (const doc of response.documents) {
            try {
                await databases.updateDocument(DATABASE_ID, EVENTS_TABLE_ID, doc.$id, { isArchived: true });
                archived += 1;
                log(`Archived event: ${doc.$id}`);
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log(`Failed to archive event ${doc.$id}: ${errMsg}`);
            }
        }
        log(`Auto-archive complete. Archived: ${archived}`);
        return { archived };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Error auto-archiving events: ${errorMessage}`);
        return { archived: 0 };
    }
}
function normalizeHttpMethod(method) {
    return (method ?? 'GET').toUpperCase();
}
function isPost(req) {
    return normalizeHttpMethod(req.method) === 'POST';
}
/**
 * Match a route from Appwrite's req.path and/or req.url pathname.
 * Cloud may pass a full pathname; xpath from executions should still match by suffix.
 */
function pathMatchesRoute(req, route) {
    const target = route.split('?')[0];
    const normalizedTarget = target.length > 1 && target.endsWith('/') ? target.slice(0, -1) : target;
    const candidates = [];
    if (typeof req.path === 'string') {
        candidates.push(req.path.split('?')[0]);
    }
    try {
        if (typeof req.url === 'string' && req.url.length > 0) {
            candidates.push(new URL(req.url).pathname.split('?')[0]);
        }
    }
    catch {
        // ignore malformed url
    }
    for (let raw of candidates) {
        if (raw === undefined)
            continue;
        const p = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
        if (p === normalizedTarget)
            return true;
        if (normalizedTarget !== '/' &&
            p.endsWith(normalizedTarget) &&
            (p.length === normalizedTarget.length || p[p.length - normalizedTarget.length - 1] === '/')) {
            return true;
        }
    }
    return false;
}
function scheduledRunPathsMatch(req) {
    if (pathMatchesRoute(req, '/check-event-reminders'))
        return true;
    if (pathMatchesRoute(req, '/'))
        return true;
    if (req.path === '')
        return true;
    return false;
}
/** Appwrite recommends bodyJson / bodyText instead of legacy req.body */
function parseJsonBodyFromReq(req) {
    const r = req;
    if (r.bodyJson != null && typeof r.bodyJson === 'object' && !Array.isArray(r.bodyJson)) {
        return r.bodyJson;
    }
    if (typeof r.bodyText === 'string' && r.bodyText.trim().length > 0) {
        return JSON.parse(r.bodyText);
    }
    if (typeof req.body === 'string' && req.body.trim().length > 0) {
        return JSON.parse(req.body);
    }
    if (req.body != null && typeof req.body === 'object' && !Array.isArray(req.body)) {
        return req.body;
    }
    throw new Error('Request body is required');
}
export default async function handler({ req, res, log, error }) {
    try {
        log(`[handler] method=${String(req.method)} path=${String(req.path)} url=${String(req.url ?? '')}`);
        // Initialize Appwrite client
        const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1';
        const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID || '691d4a54003b21bf0136';
        const apiKey = process.env.APPWRITE_FUNCTION_KEY ||
            process.env.APPWRITE_API_KEY ||
            req.headers['x-appwrite-key'] ||
            req.headers['x-appwrite-function-key'] ||
            '';
        if (!apiKey) {
            error('API key is missing');
            return res.json({
                success: false,
                error: 'Server configuration error: API key missing',
            }, 500);
        }
        const client = new Client()
            .setEndpoint(endpoint)
            .setProject(projectId)
            .setKey(apiKey);
        const databases = new Databases(client);
        const messaging = new Messaging(client);
        const appwriteUsers = new Users(client);
        // Handle ping endpoint
        if (pathMatchesRoute(req, '/ping')) {
            return res.text('Pong');
        }
        // Handle send notification endpoint
        if (pathMatchesRoute(req, '/send-notification') && isPost(req)) {
            log('Processing send-notification request');
            // Parse and validate request body
            let requestBody;
            try {
                const body = parseJsonBodyFromReq(req);
                if (!body.notificationId || typeof body.notificationId !== 'string') {
                    throw new Error('notificationId is required and must be a string');
                }
                requestBody = {
                    notificationId: body.notificationId,
                };
            }
            catch (validationError) {
                const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
                error(`Validation error: ${errorMessage}`);
                return res.json({
                    success: false,
                    error: errorMessage,
                }, 400);
            }
            log(`Sending notification: ${requestBody.notificationId}`);
            // Send notification using Appwrite Messaging
            const result = await sendNotification(databases, messaging, requestBody.notificationId, log);
            log(`Notification send handler finished. success=${result.success} recipients=${result.recipients}${result.messageId ? `, Message ID: ${result.messageId}` : ''}`);
            // Always return JSON the admin client can parse (avoid ambiguous spreads).
            return res.json({
                success: result.success,
                recipients: result.recipients,
                messageId: result.messageId,
                error: result.error,
            });
        }
        // Handle badge notification endpoint (triggered by admin portal)
        if (pathMatchesRoute(req, '/send-badge-notification') && isPost(req)) {
            log('Processing send-badge-notification request');
            let requestBody;
            try {
                const body = parseJsonBodyFromReq(req);
                if (!body.userId || typeof body.userId !== 'string') {
                    throw new Error('userId is required and must be a string');
                }
                if (body.badgeType !== 'ambassador' && body.badgeType !== 'influencer') {
                    throw new Error('badgeType must be "ambassador" or "influencer"');
                }
                requestBody = {
                    userId: body.userId,
                    badgeType: body.badgeType,
                };
            }
            catch (validationError) {
                const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
                error(`Validation error: ${errorMessage}`);
                return res.json({ success: false, error: errorMessage }, 400);
            }
            const result = await sendBadgeNotification(databases, messaging, requestBody.userId, requestBody.badgeType, log);
            return res.json(result);
        }
        // Handle tier notification endpoint (triggered by admin portal)
        if (pathMatchesRoute(req, '/send-tier-notification') && isPost(req)) {
            log('Processing send-tier-notification request');
            let requestBody;
            try {
                const body = parseJsonBodyFromReq(req);
                if (!body.userId || typeof body.userId !== 'string') {
                    throw new Error('userId is required and must be a string');
                }
                if (!body.newTierName || typeof body.newTierName !== 'string') {
                    throw new Error('newTierName is required and must be a string');
                }
                requestBody = {
                    userId: body.userId,
                    newTierName: body.newTierName,
                    oldTierName: typeof body.oldTierName === 'string' && body.oldTierName.trim().length > 0
                        ? body.oldTierName
                        : undefined,
                };
            }
            catch (validationError) {
                const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
                error(`Validation error: ${errorMessage}`);
                return res.json({ success: false, error: errorMessage }, 400);
            }
            const result = await sendTierNotification(databases, messaging, requestBody.userId, requestBody.newTierName, requestBody.oldTierName, log);
            return res.json(result);
        }
        // Handle referral points notification endpoint (triggered by referral award flows)
        if (pathMatchesRoute(req, '/send-referral-points-notification') && isPost(req)) {
            log('Processing send-referral-points-notification request');
            let requestBody;
            try {
                const body = parseJsonBodyFromReq(req);
                if (!body.userId || typeof body.userId !== 'string') {
                    throw new Error('userId is required and must be a string');
                }
                if (body.points !== undefined && (typeof body.points !== 'number' || body.points <= 0)) {
                    throw new Error('points must be a positive number when provided');
                }
                requestBody = {
                    userId: body.userId,
                    points: body.points,
                };
            }
            catch (validationError) {
                const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
                error(`Validation error: ${errorMessage}`);
                return res.json({ success: false, error: errorMessage }, 400);
            }
            const result = await sendReferralPointsNotification(databases, messaging, requestBody.userId, requestBody.points, log);
            return res.json(result);
        }
        // Simulate any notification type on-demand for testing (push + in-app, no side effects)
        if (pathMatchesRoute(req, '/simulate-notification') && isPost(req)) {
            log('Processing simulate-notification request');
            const SIMULATION_CONFIGS = {
                trivia_tuesday: {
                    title: 'TRIVIA TUESDAY',
                    body: 'Earn points by knowing fun facts about your favorite brands!',
                    notifType: 'Engagement',
                },
                nearby_sampling: {
                    title: 'NEW SAMPLING EVENT NEAR YOU',
                    body: 'Heads up, [Sample Brand] has a sampling event coming up near you. Click to learn more!',
                    notifType: 'Promotional',
                },
                sampling_today: {
                    title: 'SAMPLING TODAY',
                    body: 'Sampling at [Sample Store] starts at 10:00 AM! Click to learn more!',
                    notifType: 'Event Reminder',
                    data: { eventId: 'simulated' },
                },
                event_reminder_24h: {
                    title: 'Event Reminder: [Sample Event]',
                    body: 'Your saved event starts in 24 hours!',
                    notifType: 'Event Reminder',
                    data: { eventId: 'simulated', reminderType: '24h' },
                },
                event_reminder_1h: {
                    title: 'Event Reminder: [Sample Event]',
                    body: 'Your saved event starts in 1 hour!',
                    notifType: 'Event Reminder',
                    data: { eventId: 'simulated', reminderType: '1h' },
                },
                referral_points: {
                    title: 'REFERRAL POINTS EARNED',
                    body: 'A new user signed up using your referral code! Thank you for sharing!',
                    notifType: 'Engagement',
                },
                inactivity: {
                    title: "YOU'VE BEEN MISSING SAMPLES!",
                    body: 'Enjoy experiencing new brands, earning points and winning prizes!',
                    notifType: 'Engagement',
                },
                birthday: {
                    title: 'HAPPY BIRTHDAY!',
                    body: 'We wish you a very happy birthday, from all of us here at SampleFinder! As a gift, we\'ve awarded you 100 points.',
                    notifType: 'Engagement',
                },
                anniversary: {
                    title: 'HAPPY SAMPLING ANNIVERSARY!',
                    body: 'Congratulations on reaching a full new year of sampling with SampleFinder! As a gift, we\'ve awarded you 200 points.',
                    notifType: 'Engagement',
                },
                tier_achievement: {
                    title: 'NEW TIER ACHIEVED!',
                    body: 'Congratulations, you\'ve reached a new tier! Keep earning points to level up!',
                    notifType: 'Engagement',
                },
                badge_achievement: {
                    title: 'BADGE EARNED!',
                    body: 'Congratulations, you\'ve earned a new badge!',
                    notifType: 'Engagement',
                },
            };
            let email;
            let simType;
            try {
                const body = parseJsonBodyFromReq(req);
                if (!body.email || typeof body.email !== 'string') {
                    throw new Error('email is required and must be a string');
                }
                if (!body.type || typeof body.type !== 'string') {
                    throw new Error(`type is required. Valid types: ${Object.keys(SIMULATION_CONFIGS).join(', ')}`);
                }
                email = body.email;
                simType = body.type;
            }
            catch (validationError) {
                const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
                error(`Validation error (simulate-notification): ${errorMessage}`);
                return res.json({ success: false, error: errorMessage }, 400);
            }
            const validTypes = [...Object.keys(SIMULATION_CONFIGS), 'all'];
            if (!validTypes.includes(simType)) {
                const errorMessage = `Unknown type: ${simType}. Valid types: ${validTypes.join(', ')}`;
                error(errorMessage);
                return res.json({ success: false, error: errorMessage }, 400);
            }
            // Look up auth user by email, then find their profile by authID
            let profile;
            try {
                const authResult = await appwriteUsers.list([
                    Query.equal('email', [email]),
                    Query.limit(1),
                ]);
                if (authResult.users.length === 0) {
                    return res.json({ success: false, error: `No user found with email: ${email}` }, 404);
                }
                const authUser = authResult.users[0];
                const profileResult = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('authID', [authUser.$id]), Query.limit(1)]);
                if (profileResult.documents.length === 0) {
                    return res.json({ success: false, error: `No user profile found for email: ${email}` }, 404);
                }
                profile = profileResult.documents[0];
            }
            catch (fetchError) {
                const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
                error(`Failed to look up user by email: ${errorMessage}`);
                return res.json({ success: false, error: `User lookup failed: ${errorMessage}` }, 500);
            }
            // If type is "all", send every notification type in sequence
            const typesToSend = simType === 'all'
                ? Object.keys(SIMULATION_CONFIGS)
                : [simType];
            const results = [];
            for (const currentType of typesToSend) {
                const currentConfig = SIMULATION_CONFIGS[currentType];
                try {
                    const result = await sendImmediateSystemNotificationToUser(databases, messaging, profile, currentConfig.title, currentConfig.body, currentConfig.notifType, log, { simulated: 'true', simulationType: currentType, ...(currentConfig.data ?? {}) });
                    results.push({ type: currentType, success: result.success, sentCount: result.sentCount });
                }
                catch (sendError) {
                    const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);
                    log(`Simulate ${currentType} failed: ${errorMessage}`);
                    results.push({ type: currentType, success: false, sentCount: 0, error: errorMessage });
                }
            }
            const totalSent = results.reduce((sum, r) => sum + r.sentCount, 0);
            const allSuccess = results.every((r) => r.success);
            return res.json({
                success: allSuccess,
                sentCount: totalSent,
                simulated: true,
                type: simType,
                results,
            });
        }
        if (pathMatchesRoute(req, '/send-user-push') && isPost(req)) {
            log('Processing send-user-push request');
            let requestBody;
            try {
                const body = parseJsonBodyFromReq(req);
                const { userId, title, message, data } = body;
                if (!userId || typeof userId !== 'string') {
                    throw new Error('userId is required and must be a string');
                }
                if (!title || typeof title !== 'string') {
                    throw new Error('title is required and must be a string');
                }
                if (!message || typeof message !== 'string') {
                    throw new Error('message is required and must be a string');
                }
                if (data && typeof data !== 'object') {
                    throw new Error('data must be an object if provided');
                }
                // Normalize data to Record<string, string>
                const payloadData = {};
                if (data && typeof data === 'object') {
                    Object.entries(data).forEach(([key, value]) => {
                        payloadData[key] = String(value);
                    });
                }
                requestBody = {
                    userId,
                    title,
                    message,
                    data: payloadData,
                };
            }
            catch (validationError) {
                const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
                error(`Validation error (send-user-push): ${errorMessage}`);
                return res.json({
                    success: false,
                    error: errorMessage,
                }, 400);
            }
            log(`Sending push notification to user: ${requestBody.userId}`);
            const pushResult = await sendPushNotificationToUsers(messaging, [requestBody.userId], requestBody.title, requestBody.message, log, requestBody.data);
            const success = pushResult.status !== 'failed';
            return res.json({
                success,
                status: pushResult.status,
                messageId: pushResult.$id,
                sentCount: pushResult.sentCount ?? (success ? 1 : 0),
            });
        }
        // Handle batch push endpoint (used by mobile app)
        if (pathMatchesRoute(req, '/send-batch-push') && isPost(req)) {
            log('Processing send-batch-push request');
            let requestBody;
            try {
                const body = parseJsonBodyFromReq(req);
                const { userIds, title, message, data } = body;
                if (!Array.isArray(userIds) || userIds.length === 0) {
                    throw new Error('userIds is required and must be a non-empty array of strings');
                }
                if (!title || typeof title !== 'string') {
                    throw new Error('title is required and must be a string');
                }
                if (!message || typeof message !== 'string') {
                    throw new Error('message is required and must be a string');
                }
                if (data && typeof data !== 'object') {
                    throw new Error('data must be an object if provided');
                }
                const normalizedUserIds = userIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
                if (normalizedUserIds.length === 0) {
                    throw new Error('userIds must contain at least one valid string');
                }
                // Normalize data to Record<string, string>
                const payloadData = {};
                if (data && typeof data === 'object') {
                    Object.entries(data).forEach(([key, value]) => {
                        payloadData[key] = String(value);
                    });
                }
                requestBody = {
                    userIds: normalizedUserIds,
                    title,
                    message,
                    data: payloadData,
                };
            }
            catch (validationError) {
                const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
                error(`Validation error (send-batch-push): ${errorMessage}`);
                return res.json({
                    success: false,
                    error: errorMessage,
                }, 400);
            }
            log(`Sending batch push notification to ${requestBody.userIds.length} users`);
            const pushResult = await sendPushNotificationToUsers(messaging, requestBody.userIds, requestBody.title, requestBody.message, log, requestBody.data);
            const success = pushResult.status !== 'failed';
            return res.json({
                success,
                status: pushResult.status,
                messageId: pushResult.$id,
                sentCount: pushResult.sentCount ?? (success ? requestBody.userIds.length : 0),
            });
        }
        // Handle scheduled execution: event reminders + due scheduled notifications
        // Triggered by: Appwrite cron (path / or empty) or manual GET /check-event-reminders
        const isScheduledRun = scheduledRunPathsMatch(req);
        if (isScheduledRun) {
            log('Processing scheduled run: event reminders + scheduled notifications');
            const { hour: easternHour } = getTimePartsInTimezone(new Date(), EST_TIMEZONE);
            const shouldRunScheduledNotifications = easternHour === NOTIFICATION_SEND_HOUR_EST;
            const shouldRunMorningCampaigns = isInMorningWindowET(new Date());
            let scheduledResult = { success: true, sent: 0, failed: 0 };
            if (shouldRunScheduledNotifications) {
                // 1. Send due scheduled notifications (status=Scheduled, scheduledAt <= now)
                scheduledResult = await checkAndSendScheduledNotifications(databases, messaging, log);
                log(`Scheduled notifications: sent=${scheduledResult.sent}, failed=${scheduledResult.failed}`);
            }
            else {
                log(`Skipping admin scheduled notifications. Current ET hour is ${easternHour}; those only send at 1:00 PM ET.`);
            }
            // 2. Check and send event reminders (24h / 1h)
            const remindersResult = await checkAndSendEventReminders(databases, messaging, log);
            log(`Event reminders: 24h=${remindersResult.reminders24h}, 1h=${remindersResult.reminders1h}`);
            // 3. Auto-archive events that completed more than 7 days ago
            const archiveResult = await archiveEventsCompletedOver7DaysAgo(databases, log);
            log(`Auto-archive events: ${archiveResult.archived}`);
            // 4. Trivia Tuesday (Tuesday morning ET, once per Eastern calendar day)
            let triviaTuesdayResult = { sent: 0 };
            if (shouldRunMorningCampaigns) {
                triviaTuesdayResult = await checkAndSendTriviaTuesday(databases, messaging, log);
                log(`Trivia Tuesday: sent=${triviaTuesdayResult.sent}`);
            }
            else {
                log(`Trivia Tuesday: skipped outside morning window (${MORNING_START_HOUR_ET}:00–${MORNING_END_HOUR_ET}:00 ET)`);
            }
            // 5. Sampling Today (morning ET on the day of the event)
            let samplingTodayResult = { sent: 0 };
            if (shouldRunMorningCampaigns) {
                samplingTodayResult = await checkAndSendSamplingToday(databases, messaging, log);
                log(`Sampling Today: sent=${samplingTodayResult.sent}`);
            }
            else {
                log(`Sampling Today: skipped outside morning window (${MORNING_START_HOUR_ET}:00–${MORNING_END_HOUR_ET}:00 ET)`);
            }
            // 5b. New sampling event near you (favorite brand, 50 mi, 7 days)
            let nearbyFavoriteResult = { sent: 0 };
            if (shouldRunMorningCampaigns) {
                nearbyFavoriteResult = await checkAndSendNearbyFavoriteSampling(databases, messaging, log);
                log(`Nearby favorite sampling: sent=${nearbyFavoriteResult.sent}`);
            }
            else {
                log('Nearby favorite sampling: skipped outside morning ET window');
            }
            // 6. Happy Birthday (once per year per user)
            const birthdayResult = await checkAndSendBirthdayNotifications(databases, messaging, log);
            log(`Birthday: sent=${birthdayResult.sent}`);
            // 7. Happy Sampling Anniversary (once per year per user)
            const anniversaryResult = await checkAndSendAnniversaryNotifications(databases, messaging, log);
            log(`Anniversary: sent=${anniversaryResult.sent}`);
            // 8. Inactivity re-engagement (30+ days inactive)
            const inactivityResult = await checkAndSendInactivityNotifications(databases, messaging, appwriteUsers, log);
            log(`Inactivity: sent=${inactivityResult.sent}`);
            return res.json({
                success: true,
                scheduledNotifications: {
                    sent: scheduledResult.sent,
                    failed: scheduledResult.failed,
                },
                eventReminders: {
                    reminders24h: remindersResult.reminders24h,
                    reminders1h: remindersResult.reminders1h,
                },
                eventAutoArchive: {
                    archived: archiveResult.archived,
                },
                triviaTuesday: {
                    sent: triviaTuesdayResult.sent,
                },
                samplingToday: {
                    sent: samplingTodayResult.sent,
                },
                nearbyFavoriteSampling: {
                    sent: nearbyFavoriteResult.sent,
                },
                birthday: {
                    sent: birthdayResult.sent,
                },
                anniversary: {
                    sent: anniversaryResult.sent,
                },
                inactivity: {
                    sent: inactivityResult.sent,
                },
            });
        }
        // Default response
        return res.json({
            motto: 'Build like a team of hundreds_',
            learn: 'https://appwrite.io/docs',
            connect: 'https://appwrite.io/discord',
            getInspired: 'https://builtwith.appwrite.io',
        });
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Internal server error';
        error(`Function error: ${errorMessage}`);
        console.error('Function error:', err);
        return res.json({
            success: false,
            error: errorMessage,
        }, 500);
    }
}
