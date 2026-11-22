/**
 * Guidance Counselling Scheduling Module
 * Handles appointment booking for users and management for admins
 */

let supabase;
let currentUser = null;
let currentUserProfile = null;
let isAdmin = false;
let currentMonth = new Date();
let selectedDate = null;
let selectedTime = null;
let unavailableDatesSet = new Set();
let bookedSlotsForDate = new Set();
let adminBookingsCache = [];

// Time slots available
const TIME_SLOTS = [
    '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'
];

// Initialize the module
async function initGuidanceCounselling() {
    try {
        supabase = getSupabaseClient();
        currentUser = await checkUserAuthentication();
        
        if (!currentUser) {
            window.location.href = '/HTML/1_LogIn_Page.html';
            return;
        }

        // Check if user is admin
        isAdmin = await checkAdminStatus();

        // Load profile for display names in notifications
        try {
            const { data: profile } = await supabase
                .from('users')
                .select('full_name, username, email')
                .eq('id', currentUser.id)
                .maybeSingle();
            currentUserProfile = profile || null;
        } catch (_) { /* profile optional */ }

        // Setup event listeners
        setupEventListeners();

        // Prevent picking past dates
        const today = new Date().toISOString().split('T')[0];
        const sessionDateInput = document.getElementById('sessionDate');
        const unavailableDateInput = document.getElementById('unavailableDate');
        if (sessionDateInput) sessionDateInput.min = today;
        if (unavailableDateInput) unavailableDateInput.min = today;

        // Initialize calendar (only if the calendar markup exists)
        if (document.getElementById('calendarGrid')) {
            renderCalendar();
        }

        // Load sessions
        await loadUserSessions();
        await loadUnavailableDates();

        // Show appropriate view
        if (isAdmin) {
            document.getElementById('adminView').style.display = 'block';
            document.getElementById('userView').style.display = 'none';
            await loadAdminBookings();
        } else {
            document.getElementById('userView').style.display = 'block';
            document.getElementById('adminView').style.display = 'none';
        }

    } catch (error) {
        console.error('Error initializing guidance counselling:', error);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Failed to initialize the page. Please refresh and try again.', 'error');
        }
    }
}

// Check admin status
async function checkAdminStatus() {
    try {
        // Check users.is_admin
        const { data: userData } = await supabase
            .from('users')
            .select('is_admin')
            .eq('id', currentUser.id)
            .maybeSingle();

        if (userData?.is_admin) {
            return true;
        }

        // Check admins table
        const { data: adminData } = await supabase
            .from('admins')
            .select('user_id')
            .eq('user_id', currentUser.id)
            .maybeSingle();

        return !!adminData;
    } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
    }
}

// Setup event listeners
function setupEventListeners() {
    // Calendar navigation (elements may not exist on all layouts)
    document.getElementById('prevMonth')?.addEventListener('click', () => {
        currentMonth.setMonth(currentMonth.getMonth() - 1);
        renderCalendar();
    });

    document.getElementById('nextMonth')?.addEventListener('click', () => {
        currentMonth.setMonth(currentMonth.getMonth() + 1);
        renderCalendar();
    });

    // Date selection
    document.getElementById('sessionDate')?.addEventListener('change', (e) => {
        selectedDate = e.target.value;
        updateBookButton();
        if (selectedDate) {
            onSessionDateSelected(selectedDate);
        } else {
            resetTimeSlotSelect();
        }
    });

    // Time selection
    document.getElementById('sessionTime')?.addEventListener('change', (e) => {
        selectedTime = e.target.value;
        updateBookButton();
    });

    // Email confirmation
    document.getElementById('emailConfirmation')?.addEventListener('change', updateBookButton);

    // Schedule button
    document.getElementById('scheduleBtn')?.addEventListener('click', scheduleSession);

    // Admin tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            switchTab(tab);
        });
    });

    // Add unavailable date (admin)
    document.getElementById('addUnavailableDate')?.addEventListener('click', addUnavailableDate);

    // Success modal
    document.getElementById('closeSuccessModal')?.addEventListener('click', () => {
        const m = document.getElementById('successModal');
        if (m) m.style.display = 'none';
    });

    document.getElementById('closeSuccessBtn')?.addEventListener('click', () => {
        const m = document.getElementById('successModal');
        if (m) m.style.display = 'none';
    });
}

// Render calendar
function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    const monthYear = document.getElementById('monthYear');
    if (!grid || !monthYear) return;
    
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    
    monthYear.textContent = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();
    
    let html = '';
    
    // Day headers
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    days.forEach(day => {
        html += `<div class="calendar-day-header">${day}</div>`;
    });
    
    // Empty cells for days before first day of month
    for (let i = 0; i < startingDayOfWeek; i++) {
        html += '<div class="calendar-day empty"></div>';
    }
    
    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const isToday = date.toDateString() === new Date().toDateString();
        const isPast = date < new Date(new Date().setHours(0, 0, 0, 0));
        const isWeekend = date.getDay() === 0 || date.getDay() === 6;
        
        let classes = 'calendar-day';
        if (isToday) classes += ' today';
        if (isPast || isWeekend) classes += ' disabled';
        if (selectedDate === date.toISOString().split('T')[0]) classes += ' selected';
        
        html += `<div class="${classes}" data-date="${date.toISOString().split('T')[0]}">${day}</div>`;
    }
    
    grid.innerHTML = html;
    
    // Add click listeners to calendar days
    grid.querySelectorAll('.calendar-day:not(.empty):not(.disabled)').forEach(day => {
        day.addEventListener('click', (e) => {
            const date = e.target.dataset.date;
            selectDate(date);
        });
    });
}

// Select a date
function selectDate(date) {
    selectedDate = date;
    document.getElementById('sessionDate').value = date;
    renderCalendar();
    loadAvailableTimeSlots(date);
    updateBookButton();
}

// Load available time slots for a date (legacy calendar-grid layout)
async function loadAvailableTimeSlots(date) {
    const timeGrid = document.getElementById('timeGrid');
    if (!timeGrid || !date) return;
    timeGrid.innerHTML = '<div class="loading">Loading available times...</div>';

    try {
        // Get existing bookings for this date
        const { data: bookings } = await supabase
            .from('counselling_bookings')
            .select('time_slot')
            .eq('session_date', date)
            .eq('status', 'scheduled');

        const bookedTimes = bookings?.map(b => b.time_slot) || [];

        let html = '';
        TIME_SLOTS.forEach(time => {
            const isBooked = bookedTimes.includes(time);
            const isAvailable = !isBooked;
            
            html += `
                <div class="time-slot ${isAvailable ? 'available' : 'booked'}" data-time="${time}">
                    ${formatTime(time)}
                </div>
            `;
        });

        timeGrid.innerHTML = html;

        // Add click listeners
        timeGrid.querySelectorAll('.time-slot.available').forEach(slot => {
            slot.addEventListener('click', (e) => {
                selectedTime = e.target.dataset.time;
                document.getElementById('sessionTime').value = selectedTime;
                
                // Update selected state
                timeGrid.querySelectorAll('.time-slot').forEach(s => s.classList.remove('selected'));
                e.target.classList.add('selected');
                
                updateBookButton();
            });
        });

    } catch (error) {
        console.error('Error loading time slots:', error);
        timeGrid.innerHTML = '<div class="error">Failed to load time slots</div>';
    }
}

// Format time for display
function formatTime(time) {
    const [hours, minutes] = time.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour > 12 ? hour - 12 : hour;
    return `${displayHour}:00 ${ampm}`;
}

// ─── Booking slot management (student view) ─────────────────────────────────

// Called when the student picks a date — blocks unavailable dates and
// refreshes which time slots are already taken.
async function onSessionDateSelected(date) {
    if (unavailableDatesSet.has(date)) {
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Date unavailable', 'That date has been marked unavailable for counselling. Please pick another date.', 'warning');
        }
        document.getElementById('sessionDate').value = '';
        selectedDate = null;
        selectedTime = null;
        resetTimeSlotSelect();
        updateBookButton();
        return;
    }
    await loadBookedSlotsForDate(date);
}

// Rebuild the time <select>, disabling slots that are pending/scheduled.
function resetTimeSlotSelect() {
    const select = document.getElementById('sessionTime');
    if (!select) return;
    select.innerHTML = '<option value="">Select a time slot</option>';
    TIME_SLOTS.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = formatTime(t);
        select.appendChild(opt);
    });
    selectedTime = '';
}

// Fetch taken slots for a date and mark them disabled in the select.
async function loadBookedSlotsForDate(date) {
    bookedSlotsForDate = new Set();
    try {
        // gcfs_booked_slots() exposes only date/time/status so
        // students can see booked slots without reading other bookings.
        const { data: slots, error } = await supabase
            .rpc('gcfs_booked_slots');

        if (!error && Array.isArray(slots)) {
            slots.forEach(s => {
                if (String(s.session_date || '') !== date) return;
                const t = String(s.time_slot || '').slice(0, 5);
                if (t) bookedSlotsForDate.add(t);
            });
        }
    } catch (e) {
        console.warn('Could not load booked slots:', e);
    }

    const select = document.getElementById('sessionTime');
    if (!select) return;
    select.innerHTML = '<option value="">Select a time slot</option>';
    TIME_SLOTS.forEach(t => {
        const booked = bookedSlotsForDate.has(t);
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = booked ? `${formatTime(t)} — Booked` : formatTime(t);
        if (booked) opt.disabled = true;
        select.appendChild(opt);
    });
    selectedTime = '';
}

// ─── Admin helpers ───────────────────────────────────────────────────────────

// Collect user ids of everyone who should get booking notifications
// (admins table + users.is_admin), excluding the current user.
async function getAdminUserIds() {
    const ids = new Set();
    // Preferred: security-definer RPC (works even when students can't
    // read the admins table or other users' rows under RLS).
    try {
        const { data: rpcIds, error } = await supabase.rpc('gcfs_admin_user_ids');
        if (!error && Array.isArray(rpcIds)) {
            rpcIds.forEach(id => id && ids.add(id));
            if (currentUser?.id) ids.delete(currentUser.id);
            return [...ids];
        }
    } catch (e) { console.warn('admin ids RPC failed:', e); }
    // Fallback: direct table reads (works for admins)
    try {
        const { data: adminRows } = await supabase.from('admins').select('user_id');
        (adminRows || []).forEach(a => a.user_id && ids.add(a.user_id));
    } catch (e) { console.warn('admins lookup failed:', e); }
    try {
        const { data: adminUsers } = await supabase.from('users').select('id').eq('is_admin', true);
        (adminUsers || []).forEach(u => u.id && ids.add(u.id));
    } catch (e) { console.warn('is_admin lookup failed:', e); }
    if (currentUser?.id) ids.delete(currentUser.id);
    return [...ids];
}

async function insertNotification(recipientId, type, title, message) {
    try {
        const { error } = await supabase.from('notifications').insert({
            user_id: recipientId,
            actor_id: currentUser?.id || null,
            type,
            title,
            message,
            is_read: false
        });
        if (error) console.warn('Notification insert failed:', error.message || error);
    } catch (e) {
        console.warn('Notification insert failed:', e);
    }
}

function studentDisplayName(user) {
    return currentUserProfile?.full_name
        || currentUserProfile?.username
        || user?.full_name
        || user?.username
        || user?.email
        || 'A student';
}

// Update book button state
function updateBookButton() {
    const btn = document.getElementById('scheduleBtn');
    const date = document.getElementById('sessionDate').value;
    const time = document.getElementById('sessionTime').value;
    const topic = document.getElementById('sessionTopic').value;
    const emailConfirm = document.getElementById('emailConfirmation').checked;

    btn.disabled = !(date && time && topic && emailConfirm);
}

// Schedule a session (creates a PENDING booking — admin must approve)
async function scheduleSession() {
    const btn = document.getElementById('scheduleBtn');
    btn.disabled = true;
    btn.textContent = 'Scheduling...';

    try {
        // Double-booking guard: re-check the slot is still free
        const { data: bookedRows } = await supabase
            .rpc('gcfs_booked_slots');

        const clash = (bookedRows || []).filter(r =>
            String(r.session_date || '') === selectedDate &&
            String(r.time_slot || '').slice(0, 5) === String(selectedTime || '').slice(0, 5)
        );

        if (clash.length > 0) {
            CustomAlert.show('Slot no longer available', 'Someone else just booked that time slot. Please pick another time.', 'warning');
            await loadBookedSlotsForDate(selectedDate);
            return;
        }

        const sessionData = {
            user_id: currentUser.id,
            session_date: selectedDate,
            time_slot: selectedTime,
            topic: document.getElementById('sessionTopic').value,
            notes: document.getElementById('sessionNotes').value || null,
            status: 'pending',
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('counselling_bookings')
            .insert([sessionData])
            .select();

        if (error) throw error;

        // Notify all admins that a new booking request came in
        const adminIds = await getAdminUserIds();
        const dateLabel = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
        });
        const topicLabel = document.getElementById('sessionTopic').value;
        await Promise.all(adminIds.map(uid => insertNotification(
            uid,
            'counselling_booking_request',
            'New counselling booking request',
            `${studentDisplayName(currentUser)} requested a session on ${dateLabel} at ${formatTime(selectedTime)} (topic: ${topicLabel}). Open Guidance Counselling to approve or reject.`
        )));

        // Show success modal
        const successModal = document.getElementById('successModal');
        if (successModal) successModal.style.display = 'flex';
        const confirmText = successModal?.querySelector('.confirmation-details');
        if (confirmText) {
            confirmText.textContent = 'Your request was sent to the Guidance Office for approval. You will be notified once an admin approves it.';
        }

        // Reset form
        document.getElementById('sessionDate').value = '';
        document.getElementById('sessionTime').innerHTML = '<option value="">Select a time slot</option>' + TIME_SLOTS.map(t => `<option value="${t}">${formatTime(t)}</option>`).join('');
        document.getElementById('sessionTopic').value = '';
        document.getElementById('sessionNotes').value = '';
        document.getElementById('emailConfirmation').checked = false;
        selectedDate = null;
        selectedTime = null;
        bookedSlotsForDate = new Set();

        // Reload sessions
        await loadUserSessions();

        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Request sent', 'Your counselling request is pending admin approval. You will be notified once it is approved.', 'success');
        }

    } catch (error) {
        console.error('Error scheduling session:', error);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Failed to schedule session. Please try again.', 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = 'Schedule Session';
    }
}

// Load user's upcoming sessions
async function loadUserSessions() {
    try {
        const { data: sessions, error } = await supabase
            .from('counselling_bookings')
            .select('*')
            .eq('user_id', currentUser.id)
            .in('status', ['pending', 'scheduled'])
            .gte('session_date', new Date().toISOString().split('T')[0])
            .order('session_date', { ascending: true });

        if (error) throw error;

        const sessionsList = document.getElementById('upcomingSessionsList');
        
        if (!sessions || sessions.length === 0) {
            sessionsList.innerHTML = '<div class="empty-state"><p>No upcoming sessions scheduled.</p></div>';
            return;
        }

        const statusLabel = { pending: 'Pending approval', scheduled: 'Scheduled' };

        let html = '';
        sessions.forEach(session => {
            const date = new Date(session.session_date + 'T00:00:00');
            const formattedDate = date.toLocaleDateString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long',
                day: 'numeric' 
            });

            const st = session.status || 'scheduled';

            html += `
                <div class="session-card">
                    <div class="session-header">
                        <h4>${formattedDate}</h4>
                        <span class="session-time">${formatTime(session.time_slot)}</span>
                    </div>
                    <div class="session-details">
                        <p><strong>Topic:</strong> ${session.topic}</p>
                        ${session.notes ? `<p><strong>Notes:</strong> ${session.notes}</p>` : ''}
                        <p><strong>Status:</strong> <span class="status-badge ${st}">${statusLabel[st] || st}</span></p>
                    </div>
                    <button class="btn-cancel" onclick="cancelSession('${session.id}')">Cancel Session</button>
                </div>
            `;
        });

        sessionsList.innerHTML = html;

    } catch (error) {
        console.error('Error loading sessions:', error);
    }
}

// Load unavailable dates
async function loadUnavailableDates() {
    try {
        const { data: dates, error } = await supabase
            .from('counselling_unavailable_dates')
            .select('unavailable_date')
            .gte('unavailable_date', new Date().toISOString().split('T')[0])
            .order('unavailable_date', { ascending: true });

        if (error) throw error;

        unavailableDatesSet = new Set((dates || []).map(d => String(d.unavailable_date)));

        const datesList = document.getElementById('unavailableDatesList');
        
        if (!dates || dates.length === 0) {
            datesList.innerHTML = '<p class="no-dates">No unavailable dates currently set.</p>';
            return;
        }

        let html = '';
        dates.forEach(item => {
            const date = new Date(item.unavailable_date);
            const formattedDate = date.toLocaleDateString('en-US', { 
                weekday: 'short', 
                month: 'short', 
                day: 'numeric', 
                year: 'numeric' 
            });

            html += `<div class="unavailable-date">${formattedDate}</div>`;
        });

        datesList.innerHTML = html;

    } catch (error) {
        console.error('Error loading unavailable dates:', error);
    }
}

// Cancel a session
async function cancelSession(sessionId) {
    if (!confirm('Are you sure you want to cancel this session?')) {
        return;
    }

    try {
        const { error } = await supabase
            .from('counselling_bookings')
            .update({ status: 'cancelled' })
            .eq('id', sessionId);

        if (error) throw error;

        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Success', 'Session cancelled successfully.', 'success');
        }

        await loadUserSessions();

    } catch (error) {
        console.error('Error cancelling session:', error);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Failed to cancel session. Please try again.', 'error');
        }
    }
}

// Admin: Load all bookings
async function loadAdminBookings() {
    try {
        const { data: bookings, error } = await supabase
            .from('counselling_bookings')
            .select(`
                *,
                user:users(full_name, email, username)
            `)
            .order('session_date', { ascending: false });

        if (error) throw error;

        const bookingsList = document.getElementById('bookingsList');
        
        if (!bookings || bookings.length === 0) {
            bookingsList.innerHTML = '<div class="empty-state"><p>No bookings found.</p></div>';
            return;
        }

        const statusLabel = {
            pending: 'Pending',
            scheduled: 'Scheduled',
            completed: 'Completed',
            cancelled: 'Cancelled',
            rejected: 'Rejected'
        };

        // Pending requests first, then upcoming scheduled, then the rest
        const statusOrder = { pending: 0, scheduled: 1, completed: 2, cancelled: 3, rejected: 4 };
        bookings.sort((a, b) => {
            const so = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
            if (so !== 0) return so;
            return new Date(a.session_date) - new Date(b.session_date);
        });

        adminBookingsCache = bookings;

        let html = '';
        bookings.forEach(booking => {
            const date = new Date(booking.session_date + 'T00:00:00');
            const formattedDate = date.toLocaleDateString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            });

            const statusClass = booking.status || 'scheduled';
            const stLabel = statusLabel[statusClass] || statusClass;
            const isPending = statusClass === 'pending';
            
            html += `
                <div class="booking-card ${statusClass}">
                    <div class="booking-header">
                        <h4>${booking.user?.full_name || booking.user?.username || 'Unknown User'}</h4>
                        <span class="status-badge ${statusClass}">${stLabel}</span>
                    </div>
                    <div class="booking-details">
                        <p><strong>Email:</strong> ${booking.user?.email || 'N/A'}</p>
                        <p><strong>Date:</strong> ${formattedDate}</p>
                        <p><strong>Time:</strong> ${formatTime(booking.time_slot)}</p>
                        <p><strong>Topic:</strong> ${booking.topic}</p>
                        ${booking.notes ? `<p><strong>Notes:</strong> ${booking.notes}</p>` : ''}
                    </div>
                    <div class="booking-actions">
                        <button class="btn-copy" onclick="copyBookingDetails('${booking.id}')">Copy Details</button>
                        ${isPending ? `
                            <button class="btn-approve" onclick="adminApproveBooking('${booking.id}')">Approve</button>
                            <button class="btn-reject" onclick="adminRejectBooking('${booking.id}')">Reject</button>
                        ` : ''}
                        ${!['cancelled', 'rejected', 'completed'].includes(statusClass) ? `<button class="btn-cancel" onclick="adminCancelBooking('${booking.id}')">Cancel</button>` : ''}
                        ${statusClass === 'scheduled' ? `<button class="btn-complete" onclick="adminCompleteBooking('${booking.id}')">Mark Complete</button>` : ''}
                    </div>
                </div>
            `;
        });

        bookingsList.innerHTML = html;

    } catch (error) {
        console.error('Error loading admin bookings:', error);
        document.getElementById('bookingsList').innerHTML = '<div class="error">Failed to load bookings</div>';
    }
}

// Admin: Copy booking details to clipboard
async function copyBookingDetails(bookingId) {
    const booking = adminBookingsCache.find(b => b.id === bookingId);
    if (!booking) return;

    const date = new Date(booking.session_date + 'T00:00:00').toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const text = [
        'GC FitShare — Counselling Booking',
        `Student: ${booking.user?.full_name || booking.user?.username || 'Unknown'}`,
        `Email: ${booking.user?.email || 'N/A'}`,
        `Date: ${date}`,
        `Time: ${formatTime(booking.time_slot)}`,
        `Topic: ${booking.topic}`,
        booking.notes ? `Notes: ${booking.notes}` : null,
        `Status: ${booking.status || 'scheduled'}`
    ].filter(Boolean).join('\n');

    try {
        await navigator.clipboard.writeText(text);
        CustomAlert.show('Copied', 'Booking details copied to clipboard.', 'success');
    } catch {
        CustomAlert.show('Copy failed', 'Could not copy to clipboard. Please copy manually.', 'error');
    }
}

// Admin: Cancel a booking
async function adminCancelBooking(bookingId) {
    if (!confirm('Are you sure you want to cancel this booking?')) {
        return;
    }

    try {
        const { error } = await supabase
            .from('counselling_bookings')
            .update({ status: 'cancelled' })
            .eq('id', bookingId);

        if (error) throw error;

        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Success', 'Booking cancelled successfully.', 'success');
        }

        await loadAdminBookings();

    } catch (error) {
        console.error('Error cancelling booking:', error);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Failed to cancel booking. Please try again.', 'error');
        }
    }
}

// Admin: Approve a pending booking → notifies the student
async function adminApproveBooking(bookingId) {
    try {
        const { data: booking, error: fetchErr } = await supabase
            .from('counselling_bookings')
            .select('id, user_id, session_date, time_slot, topic, status')
            .eq('id', bookingId)
            .single();
        if (fetchErr) throw fetchErr;
        if (!booking || booking.status !== 'pending') {
            CustomAlert.show('Already handled', 'This request is no longer pending.', 'warning');
            await loadAdminBookings();
            return;
        }

        // Guard against double-booking at approval time
        const { data: other } = await supabase
            .from('counselling_bookings')
            .select('id')
            .eq('session_date', booking.session_date)
            .eq('time_slot', booking.time_slot)
            .in('status', ['pending', 'scheduled'])
            .neq('id', bookingId)
            .limit(1);

        if (other && other.length) {
            CustomAlert.show('Slot conflict', 'That date/time is already taken by another booking. Reject this request or ask the student to pick another slot.', 'warning');
            return;
        }

        const { error } = await supabase
            .from('counselling_bookings')
            .update({ status: 'scheduled', updated_at: new Date().toISOString() })
            .eq('id', bookingId);
        if (error) throw error;

        // Mark the session date as unavailable so no one else can book it
        const { error: unavailErr } = await supabase
            .from('counselling_unavailable_dates')
            .upsert(
                { unavailable_date: booking.session_date, reason: 'Approved counselling session', created_by: currentUser?.id },
                { onConflict: 'unavailable_date', ignoreDuplicates: true }
            );
        if (unavailErr) console.warn('Could not mark date unavailable:', unavailErr.message);
        unavailableDatesSet.add(String(booking.session_date));

        const dateLabel = new Date(booking.session_date + 'T00:00:00').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
        });
        await insertNotification(
            booking.user_id,
            'counselling_booking_approved',
            'Your counselling session was approved',
            `An Admin has approved your schedule. Please check your Gordon College Gmail for more details regarding your scheduled session on ${dateLabel} at ${formatTime(booking.time_slot)}.`
        );

        CustomAlert.show('Approved', 'Booking approved — the student has been notified.', 'success');
        await loadAdminBookings();
    } catch (error) {
        console.error('Error approving booking:', error);
        CustomAlert.show('Error', 'Failed to approve booking. Please try again.', 'error');
    }
}

// Admin: Reject a pending booking → notifies the student
async function adminRejectBooking(bookingId) {
    try {
        const { data: booking, error: fetchErr } = await supabase
            .from('counselling_bookings')
            .select('id, user_id, session_date, time_slot, status')
            .eq('id', bookingId)
            .single();
        if (fetchErr) throw fetchErr;
        if (!booking || booking.status !== 'pending') {
            CustomAlert.show('Already handled', 'This request is no longer pending.', 'warning');
            await loadAdminBookings();
            return;
        }

        const { error } = await supabase
            .from('counselling_bookings')
            .update({ status: 'rejected', updated_at: new Date().toISOString() })
            .eq('id', bookingId);
        if (error) throw error;

        const dateLabel = new Date(booking.session_date + 'T00:00:00').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
        });
        await insertNotification(
            booking.user_id,
            'counselling_booking_rejected',
            'Your counselling request was not approved',
            `Your requested session on ${dateLabel} at ${formatTime(booking.time_slot)} could not be approved. Please book a different slot or contact the Guidance Office.`
        );

        CustomAlert.show('Rejected', 'Request rejected — the student has been notified.', 'success');
        await loadAdminBookings();
    } catch (error) {
        console.error('Error rejecting booking:', error);
        CustomAlert.show('Error', 'Failed to reject booking. Please try again.', 'error');
    }
}

// Admin: Mark booking as complete
async function adminCompleteBooking(bookingId) {
    try {
        const { error } = await supabase
            .from('counselling_bookings')
            .update({ status: 'completed' })
            .eq('id', bookingId);

        if (error) throw error;

        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Success', 'Booking marked as complete.', 'success');
        }

        await loadAdminBookings();

    } catch (error) {
        console.error('Error completing booking:', error);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Failed to update booking. Please try again.', 'error');
        }
    }
}

// Admin: Add unavailable date
async function addUnavailableDate() {
    const dateInput = document.getElementById('unavailableDate');
    const date = dateInput.value;

    if (!date) {
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Please select a date.', 'error');
        }
        return;
    }

    try {
        const { error } = await supabase
            .from('counselling_unavailable_dates')
            .insert([{ unavailable_date: date }]);

        if (error) throw error;

        dateInput.value = '';
        await loadUnavailableDates();
        await loadAdminUnavailableDates();

        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Success', 'Date marked as unavailable.', 'success');
        }

    } catch (error) {
        console.error('Error adding unavailable date:', error);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Failed to add unavailable date. Please try again.', 'error');
        }
    }
}

// Admin: Load unavailable dates for admin view
async function loadAdminUnavailableDates() {
    try {
        const { data: dates, error } = await supabase
            .from('counselling_unavailable_dates')
            .select('*')
            .order('unavailable_date', { ascending: true });

        if (error) throw error;

        const list = document.getElementById('adminUnavailableList');
        
        if (!dates || dates.length === 0) {
            list.innerHTML = '<p class="no-dates">No unavailable dates set.</p>';
            return;
        }

        let html = '';
        dates.forEach(item => {
            const date = new Date(item.unavailable_date);
            const formattedDate = date.toLocaleDateString('en-US', { 
                weekday: 'short', 
                month: 'short', 
                day: 'numeric', 
                year: 'numeric' 
            });

            html += `
                <div class="unavailable-date-item">
                    <span>${formattedDate}</span>
                    <button class="btn-remove-date" onclick="removeUnavailableDate('${item.id}')">Remove</button>
                </div>
            `;
        });

        list.innerHTML = html;

    } catch (error) {
        console.error('Error loading admin unavailable dates:', error);
    }
}

// Admin: Remove unavailable date
async function removeUnavailableDate(dateId) {
    if (!confirm('Are you sure you want to remove this unavailable date?')) {
        return;
    }

    try {
        const { error } = await supabase
            .from('counselling_unavailable_dates')
            .delete()
            .eq('id', dateId);

        if (error) throw error;

        await loadUnavailableDates();
        await loadAdminUnavailableDates();

        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Success', 'Unavailable date removed.', 'success');
        }

    } catch (error) {
        console.error('Error removing unavailable date:', error);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Failed to remove unavailable date. Please try again.', 'error');
        }
    }
}

// Switch admin tabs
function switchTab(tab) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });

    document.getElementById(`${tab}Tab`).classList.add('active');

    // Load data for the tab
    if (tab === 'bookings') {
        loadAdminBookings();
    } else if (tab === 'availability') {
        loadAdminUnavailableDates();
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initGuidanceCounselling);
