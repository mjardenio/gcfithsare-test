/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 5_Info_Support.js — HELP, ABOUT, POLICIES, CONTACT CONTENT
 * ═══════════════════════════════════════════════════════════════════════════ 
 *
 * PURPOSE
 *   Injects section HTML into #contentArea; highlights active card; sidebar
 *   toggle. Help content loads even when auth is temporarily unavailable.
 *
 * DEPENDS ON
 *   0_Utilities.js, 0_Footer.js (sidebar buttons).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

let supabase;
let currentUser = null;

// ─── Initialize ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    supabase = getSupabaseClient();
    currentUser = await checkUserAuthentication();

    if (currentUser && await redirectIncompleteProfileSetup(currentUser)) return;

    setupEventListeners();
    if (!currentUser) {
        console.warn('Auth unavailable during page init; skipping redirect to avoid logout loops.');
    }
    showSection('help');
});

// ─── Show Section Content ───────────────────────────────────────────────────
function showSection(section) {
    const contentArea = document.getElementById('contentArea');
    const supportGrid = document.getElementById('supportGrid');

    // Highlight active card (keeps the top row consistent across sections)
    if (supportGrid) {
        supportGrid.querySelectorAll('.support-card').forEach(card => {
            card.classList.toggle('active', card.getAttribute('data-section') === section);
        });
    }
    
    let html = '';

    switch(section) {
        case 'help':
            html = `
                <h2>Help Center</h2>
                <p>This section is your first stop for understanding how GC FitShare works day to day. Whether you are new to the community or returning after a break, the topics below explain the actions you can take in the app and what to expect after you post or comment.</p>
                
                <div class="help-topics-grid">
                    <div class="help-topic-card">
                        <h4>Creating Posts</h4>
                        <p>From the main feed, use <strong>Create Post</strong> in the top bar. Add a clear title, your message, and optional image or hashtags, then submit.</p>
                    </div>
                    <div class="help-topic-card">
                        <h4>Editing & Deleting</h4>
                        <p>You can delete your own posts from the ⋯ menu on the card. Profile fields are updated through <strong>Edit Profile</strong> on your profile page.</p>
                    </div>
                    <div class="help-topic-card">
                        <h4>Expert Application</h4>
                        <p>Open <strong>Expert Application</strong> in the sidebar to read requirements and submit credentials. Approved experts receive a visible badge.</p>
                    </div>
                    <div class="help-topic-card">
                        <h4>Content Moderation</h4>
                        <p>Content is screened to reduce spam and material that does not meet community standards. If something is flagged, you may receive a notification.</p>
                    </div>
                    <div class="help-topic-card">
                        <h4>Profile Privacy</h4>
                        <p>Email, age, and other fields can be marked public or private in Edit Profile. Only share what you are comfortable with.</p>
                    </div>
                    <div class="help-topic-card">
                        <h4>Need More Help?</h4>
                        <p>If your question is not covered here, use <strong>Get Support</strong> for official contact details.</p>
                    </div>
                </div>
            `;
            break;

        case 'about':
            html = `
                <h2>About GC FitShare</h2>
                <p>GC FitShare is a dedicated wellness and peer-learning platform for the Gordon College community. It brings together students and faculty around fitness, nutrition, mental well-being, and practical habits—without mixing in unrelated social noise. Access is limited to institutional email so the environment stays focused and accountable.</p>
                
                <h3>Our mission</h3>
                <p>We aim to give every member a respectful place to ask questions, share progress, and learn from others who understand the same campus rhythm. The goal is not perfection on display, but steady improvement, honest conversation, and support that fits real student schedules.</p>
                
                <h3>What you will find here</h3>
                <ul>
                    <li><strong>Trusted access</strong> — Sign-in with your official GC email helps keep accounts aligned with the college community.</li>
                    <li><strong>Expert perspective</strong> — Faculty and approved wellness experts can highlight reliable information alongside student discussion.</li>
                    <li><strong>Moderation and safety</strong> — Automated review and community reporting work together to reduce harmful or off-topic material.</li>
                    <li><strong>Discussion tools</strong> — Voting and comments are designed to surface helpful posts, not to reward harassment or drama.</li>
                    <li><strong>Wellness-oriented organization</strong> — Categories and profiles encourage content that supports healthy routines and academic balance.</li>
                </ul>

                <p>GC FitShare is developed as an academic capstone initiative by the <strong>Mental BLVK</strong> team, with ongoing input from stakeholders who care about student life and digital responsibility on campus.</p>
            `;
            break;

        case 'policy':
            html = `
                <h2>Community guidelines &amp; policy</h2>
                <p>These guidelines exist so GC FitShare remains useful, inclusive, and appropriate for Gordon College. By using the platform, you agree to follow them and to accept proportionate action—including content removal or account restrictions—when they are seriously or repeatedly broken.</p>
                
                <h3>Community guidelines</h3>
                <p>Posts and comments should support wellness, fitness, nutrition, mental health awareness, time management, or closely related student-life topics. Keep tone constructive: disagree with ideas, not people. Commercial advertising, unrelated campaigns, or repeated off-topic links are not allowed without prior approval from the responsible office.</p>
                <ul>
                    <li>Treat others with respect; harassment, threats, slurs, and targeted bullying are prohibited.</li>
                    <li>Do not share someone else’s private information (doxing) or impersonate another person or office.</li>
                    <li>Avoid spam, automated posting, or manipulating votes and reports.</li>
                    <li>Content must remain suitable for an educational setting: no graphic violence, sexual material involving minors, or illegal activity instructions.</li>
                    <li>When in doubt, choose the kind of message you would be comfortable signing with your real name in class.</li>
                </ul>

                <h3>Privacy (summary)</h3>
                <p>Authentication relies on your institutional email; additional profile fields are stored to power features you choose to use (such as display name, course, or wellness interests). We do not sell personal data. Third-party services involved in hosting or moderation are bound by their own terms; avoid posting highly sensitive information you would not email to a colleague.</p>
                
                <h3>Content moderation</h3>
                <p>New public content may be scanned automatically for policy risk. Human moderators or designated administrators may review reports, suspend disruptive accounts, or remove material that violates these rules or applicable college policies. Appeals or clarifications should go through the support contacts listed under <strong>Get Support</strong>.</p>
            `;
            break;

        case 'support':
            html = `
                <h2>Get support</h2>
                <p>Use the channels below for official help. Brief, factual messages (what happened, when, and your GC email) make it easier to route your request to the right person and shorten response time.</p>

                <div class="support-contact">
                    <h3>Contact options</h3>
                    <p><strong>Student Affairs Office</strong><br>
                    For questions about campus policies, conduct, or general student-life matters connected to GC FitShare.<br>
                    Email: <a href="mailto:studentaffairs@gordoncollege.edu.ph">studentaffairs@gordoncollege.edu.ph</a></p>
                    
                    <p><strong>Technical support (app issues)</strong><br>
                    For login problems, bugs, or errors inside the application (screenshots welcome).<br>
                    Email: <a href="mailto:fitshare.support@gmail.com">fitshare.support@gmail.com</a></p>

                    <h3>Typical response time</h3>
                    <p>During regular school weeks, teams aim to acknowledge messages within <strong>one to two business days</strong>. Peak periods (exams, holidays) may take slightly longer; urgent safety concerns should also be reported through appropriate college channels as required.</p>
                </div>

                <div class="faq">
                    <h3>Frequently asked questions</h3>
                    <p><strong>Q:</strong> My post was removed. Why might that happen?<br>
                    <strong>A:</strong> It may have matched automated risk rules, received verified reports, or been judged inconsistent with the community guidelines. Check your notifications; if the reason is still unclear, email support with the approximate time of posting and the topic.</p>
                    <p><strong>Q:</strong> I am uncomfortable with something another user posted. What should I do?<br>
                    <strong>A:</strong> Use the in-app reporting tools where available, and contact Student Affairs if you believe the situation involves harassment or a broader campus issue.</p>
                </div>
            `;
            break;

        default:
            html = `<p>Select a section from the cards above.</p>`;
    }

    contentArea.innerHTML = html;

    // Bring content into view after clicking a card (matches the "cards top, content below" feel)
    contentArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Setup Event Listeners ──────────────────────────────────────────────────
function setupEventListeners() {
    // Dark mode + logout — handled by 0_Footer.js
}
