/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GC FITSHARE - LANDING PAGE
 * Handles smooth scrolling, header effects, and scroll animations
 * Makes the landing page feel modern and polished
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── Smooth Scroll for Anchor Links ─────────────────────────────────────────
/**
 * When user clicks a link like #features or #about,
 * smoothly scroll to that section instead of jumping
 */
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// ─── Header Scroll Effect ───────────────────────────────────────────────────
/**
 * Adds a nice shadow to the top bar when user scrolls down
 * Makes the header stand out more while scrolling
 */
const header = document.querySelector('.top-bar');

window.addEventListener('scroll', () => {
    if (!header) return;
    if (window.scrollY > 50) {
        header.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.3)';
    } else {
        header.style.boxShadow = 'none';
    }
});

// ─── Feature Cards Animation ────────────────────────────────────────────────
/**
 * Beautiful scroll animation for feature cards
 * Cards fade in and slide up as they enter the viewport
 */
function animateFeatureCards() {
    const featureCards = document.querySelectorAll('.feature-card');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry, index) => {
            if (entry.isIntersecting) {
                // Stagger the animation for a nicer effect
                setTimeout(() => {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0)';
                }, index * 100);
                
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    // Set initial hidden state
    featureCards.forEach(card => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        card.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(card);
    });
}

// ─── Initialization ─────────────────────────────────────────────────────────
/**
 * Runs when the page finishes loading
 */
document.addEventListener('DOMContentLoaded', () => {
    animateFeatureCards();
});