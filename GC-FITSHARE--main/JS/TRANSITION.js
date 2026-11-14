/**
 * PAGE TRANSITION ANIMATIONS
 * This file handles all fade in/out animations between pages
 * Shared by both Landing Page and Login Page
 */

// ══════════════════════════════════════════════════════════════
// FADE OUT ANIMATION - When leaving a page
// ══════════════════════════════════════════════════════════════

/**
 * Smoothly fade out the page and navigate to a new URL
 * @param {string} url - The page URL to navigate to
 * @param {number} duration - How long the fade lasts (milliseconds)
 */
function fadeOutAndNavigate(url, duration = 500) {
    document.body.classList.add('fade-out');
    setTimeout(() => {
        window.location.href = url;
    }, duration);
}

// ══════════════════════════════════════════════════════════════
// CTA & BUTTON TRANSITIONS - For main action buttons
// ══════════════════════════════════════════════════════════════

/**
 * Add fade transition to "Get Started" and "Sign In" buttons
 * Only activates for links that navigate to the Login Page
 */
function setupCTATransitions() {
    const ctaButtons = document.querySelectorAll('.cta-button');
    
    ctaButtons.forEach(button => {
        button.addEventListener('click', function (e) {
            const href = this.getAttribute('href');
            
            // Check if this button navigates to Login Page
            if (href && href.includes('LogIn_Page')) {
                e.preventDefault();
                fadeOutAndNavigate(href);
            }
        });
    });
}

// ══════════════════════════════════════════════════════════════
// NAVIGATION LINK TRANSITIONS - For header login link
// ══════════════════════════════════════════════════════════════

/**
 * Add fade transition to navigation menu login links
 * Makes page transitions smoother from the header
 */
function setupNavLinkTransitions() {
    const navLinks = document.querySelectorAll('.nav-link');
    
    navLinks.forEach(link => {
        if (link.classList.contains('login-link') && link.getAttribute('href').includes('LogIn_Page')) {
            link.addEventListener('click', function (e) {
                e.preventDefault();
                fadeOutAndNavigate(this.getAttribute('href'));
            });
        }
    });
}

// ══════════════════════════════════════════════════════════════
// LOGO CLICK - Back navigation
// ══════════════════════════════════════════════════════════════

/**
 * Make logo clickable to go back to Landing Page
 * Only available on Login Page
 */
function setupLogoTransition() {
    const logo = document.querySelector('.logo');
    if (logo && window.location.pathname.includes('LogIn_Page')) {
        logo.style.cursor = 'pointer';
        logo.addEventListener('click', function() {
            fadeOutAndNavigate('/HTML/0_LandingPage.html');
        });
    }
}

// ══════════════════════════════════════════════════════════════
// INITIALIZATION - Runs when page loads
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function() {
    setupCTATransitions();
    setupNavLinkTransitions();
    setupLogoTransition();
});
