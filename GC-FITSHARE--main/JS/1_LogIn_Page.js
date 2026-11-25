/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GC FITSHARE - LOGIN PAGE
 * Handles user authentication, password visibility toggle,
 * keyboard shortcuts, and Terms/Privacy modals
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── Supabase Configuration ──────────────────────────────────────────────────
// Supabase client is initialized in 0_Utilities.js
// Use: getSupabaseClient() when needed

// ─── Global References ───────────────────────────────────────────────────────
const loginBtn = document.getElementById("loginBtn");
const loader   = document.getElementById("loader");
const rememberMeCheckbox = document.getElementById("rememberMe");
const REMEMBER_ME_KEY = "gcfitshare_remember_me";
const REMEMBERED_EMAIL_KEY = "gcfitshare_remembered_email";

function setLoading(isLoading) {
    if (!loader) return;
    loader.style.display = isLoading ? "flex" : "none";
}

function getLoginFormValues() {
    return {
        email: document.getElementById("emailInput").value.trim(),
        password: document.getElementById("passwordInput").value,
        rememberMe: Boolean(rememberMeCheckbox?.checked)
    };
}

function validateCredentials(email, password) {
    if (!email || !password) {
        CustomAlert.show('Missing Info', 'Please fill in all fields.', 'error');
        return false;
    }
    if (!email.endsWith("@gordoncollege.edu.ph")) {
        CustomAlert.show('Invalid Email', 'Please use your official GC email address (@gordoncollege.edu.ph).', 'error');
        return false;
    }
    return true;
}

function persistRememberMe(rememberMe, email) {
    if (rememberMe) {
        localStorage.setItem(REMEMBER_ME_KEY, "true");
        localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
        return;
    }
    localStorage.removeItem(REMEMBER_ME_KEY);
    localStorage.removeItem(REMEMBERED_EMAIL_KEY);
}

// ─── Login Handler ───────────────────────────────────────────────────────────
/**
 * Main login function
 * Validates GC email, shows loader, authenticates with Supabase,
 * creates user record if needed, then redirects to main feed
 */
loginBtn.addEventListener("click", handleLogin);

async function handleLogin() {
    const { email, password, rememberMe } = getLoginFormValues();

    if (!validateCredentials(email, password)) {
        return;
    }

    setLoading(true);

    try {
        const supabaseClient = getSupabaseClient();

        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) throw error;

        if (data.user) {
            // Make sure user record exists in our users table
            await ensureUserExists(data.user);

            // New or incomplete student profiles continue in the existing
            // Profile editor before the rest of the application is available.
            const setupStatus = await getRequiredProfileSetupStatus(data.user);
            const nextPage = setupStatus.checked && setupStatus.required
                ? "/HTML/3_Profile.html?setup=required"
                : "/HTML/2_Main_Feed.html";

            if (typeof maybeShowSuspensionNoticeOnLogin === 'function') {
                await maybeShowSuspensionNoticeOnLogin(supabaseClient, data.user.id);
            }

            // Remember-me behavior (store email locally for future login)
            persistRememberMe(rememberMe, email);

            setLoading(false);
            showNotification("Login Successful! Welcome to GC FitShare.");

            // Redirect after short delay
            setTimeout(() => {
                window.location.href = nextPage;
            }, 1500);
        }
    } catch (error) {
        setLoading(false);
        CustomAlert.show('Login Failed', "Login failed: " + (error.message || "Invalid credentials"), 'error');
    }
}

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────
const emailInput    = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");

// Press Enter on email field → focus password
emailInput.addEventListener("keypress", function (e) {
    if (e.key === "Enter") {
        e.preventDefault();
        passwordInput.focus();
    }
});

// Press Enter on password field → trigger login
passwordInput.addEventListener("keypress", function (e) {
    if (e.key === "Enter") {
        e.preventDefault();
        handleLogin();
    }
});

// showNotification() defined in 0_Utilities.js

// ─── Password Visibility Toggle ──────────────────────────────────────────────
/**
 * Toggle between showing and hiding the password
 * Updates the eye icon accordingly
 */
function togglePassword() {
    const input = document.getElementById("passwordInput");
    const icon  = document.getElementById("toggleIcon");

    if (input.type === "password") {
        input.type = "text";
        icon.src = "/ASSETS/LOGO ICON/HIDEPASS.png";
    } else {
        input.type = "password";
        icon.src = "/ASSETS/LOGO ICON/VIEWPASS.png";
    }
}

// ─── Terms & Privacy Modals ──────────────────────────────────────────────────
/**
 * Open modal for Terms of Service or Privacy Policy
 * @param {string} type - "terms" or "privacy"
 */
function openModal(type) {
    const modal = document.getElementById("modal");
    const title = document.getElementById("modalTitle");
    const text  = document.getElementById("modalText");

    if (type === "terms") {
        title.textContent = "Terms of Service";
        text.textContent  = "By using GC FitShare, you agree to follow all platform rules and community guidelines. Content must be wellness-related and appropriate for the GC community.";
    } else {
        title.textContent = "Privacy Policy";
        text.textContent  = "Your data is kept private and secure. We only collect your GC email for authentication purposes and will never share your information without your consent.";
    }

    modal.style.display = "flex";
}

/**
 * Close the modal
 */
function closeModal() {
    document.getElementById("modal").style.display = "none";
}

// Close modal when clicking outside
document.getElementById("modal").addEventListener("click", function (e) {
    if (e.target === this) closeModal();
});

// ─── Initialization ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const savedRememberMe = localStorage.getItem(REMEMBER_ME_KEY) === "true";
    const savedEmail = localStorage.getItem(REMEMBERED_EMAIL_KEY) || "";

    if (rememberMeCheckbox) {
        rememberMeCheckbox.checked = savedRememberMe;
    }
    if (savedRememberMe && savedEmail && emailInput) {
        emailInput.value = savedEmail;
    }
});
