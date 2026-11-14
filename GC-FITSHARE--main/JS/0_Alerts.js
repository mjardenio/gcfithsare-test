/**
 * 0_Alerts.js — CustomAlert & CustomConfirm themed overlays
 *
 * Loaded before page scripts that call CustomAlert.show / CustomAlert.confirm.
 * Prefer showAppAlert() from 0_Footer.js for a single entry point on app pages.
 */

function escapeForAlert(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const CustomAlert = {
    show(title, message, type = 'info') {
        this.close();

        const colors = {
            error: '#e74c3c',
            success: '#1dd1a1',
            info: '#0984e3',
            warning: '#f39c12'
        };
        const themeColor = colors[type] || colors.info;

        const overlay = document.createElement('div');
        overlay.id = 'custom-alert-overlay';

        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); display: flex; align-items: center;
            justify-content: center; z-index: 10000; font-family: 'Segoe UI', sans-serif;
            backdrop-filter: blur(4px); transition: all 0.3s ease;
        `;

        const alertBox = document.createElement('div');

        const isDarkMode = document.body.classList.contains('dark-mode');
        const bgColor = isDarkMode ? '#1a1a1a' : '#ffffff';
        const textColor = isDarkMode ? '#e0e0e0' : '#2d3436';

        alertBox.style.cssText = `
            background: ${bgColor};
            padding: 18px 20px;
            border-radius: 8px;
            max-width: 320px;
            width: 85%;
            text-align: center;
            box-shadow: 0 8px 16px rgba(0,0,0,0.15);
            border-left: 4px solid ${themeColor};
            transform: translateY(20px);
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        `;

        const safeTitle = escapeForAlert(title);
        const safeMessage = escapeForAlert(message).replace(/\n/g, '<br>');

        alertBox.innerHTML = `
            <h3 style="margin-top: 0; color: ${themeColor}; font-size: 16px; margin-bottom: 8px; font-weight: 600;">${safeTitle}</h3>
            <p style="color: ${textColor}; line-height: 1.5; font-size: 13px; margin-bottom: 14px;">${safeMessage}</p>
            <button id="close-custom-alert" type="button" style="
                background: ${themeColor};
                color: white;
                border: none;
                padding: 8px 20px;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                font-size: 13px;
                transition: transform 0.2s ease, filter 0.2s ease;
            ">Got it</button>
        `;

        overlay.appendChild(alertBox);
        document.body.appendChild(overlay);

        setTimeout(() => {
            alertBox.style.opacity = '1';
            alertBox.style.transform = 'translateY(0)';
        }, 10);

        const btn = document.getElementById('close-custom-alert');
        btn.onmouseover = () => { btn.style.filter = 'brightness(1.1)'; };
        btn.onmouseout = () => { btn.style.filter = 'brightness(1)'; };
        btn.onclick = () => this.close();

        overlay.onclick = (e) => {
            if (e.target === overlay) this.close();
        };
    },

    /**
     * Two-button confirm dialog. Returns a Promise resolving true if confirmed.
     */
    confirm(title, message, options = {}) {
        const {
            confirmText = 'OK',
            cancelText = 'Cancel',
            danger = false
        } = options;

        return new Promise((resolve) => {
            this.close();

            const accent = danger ? '#e74c3c' : '#0984e3';
            const overlay = document.createElement('div');
            overlay.id = 'custom-alert-overlay';
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.6); display: flex; align-items: center;
                justify-content: center; z-index: 10000; font-family: 'Segoe UI', sans-serif;
                backdrop-filter: blur(4px);
            `;

            const isDarkMode = document.body.classList.contains('dark-mode');
            const bgColor = isDarkMode ? '#1a1a1a' : '#ffffff';
            const textColor = isDarkMode ? '#e0e0e0' : '#2d3436';

            const box = document.createElement('div');
            box.style.cssText = `
                background: ${bgColor};
                padding: 18px 20px;
                border-radius: 8px;
                max-width: 360px;
                width: 88%;
                text-align: center;
                box-shadow: 0 8px 16px rgba(0,0,0,0.15);
                border-left: 4px solid ${accent};
            `;

            const safeTitle = escapeForAlert(title);
            const safeMessage = escapeForAlert(message).replace(/\n/g, '<br>');
            const safeConfirm = escapeForAlert(confirmText);
            const safeCancel = escapeForAlert(cancelText);

            box.innerHTML = `
                <h3 style="margin-top: 0; color: ${accent}; font-size: 16px; margin-bottom: 8px; font-weight: 600;">${safeTitle}</h3>
                <p style="color: ${textColor}; line-height: 1.5; font-size: 13px; margin-bottom: 16px;">${safeMessage}</p>
                <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
                    <button type="button" id="custom-alert-cancel" style="
                        flex: 1; min-width: 100px;
                        background: transparent; color: ${textColor};
                        border: 1px solid ${isDarkMode ? '#555' : '#dfe6e9'};
                        padding: 8px 16px; border-radius: 6px; cursor: pointer;
                        font-weight: 600; font-size: 13px;
                    ">${safeCancel}</button>
                    <button type="button" id="custom-alert-ok" style="
                        flex: 1; min-width: 100px;
                        background: ${accent}; color: white; border: none;
                        padding: 8px 16px; border-radius: 6px; cursor: pointer;
                        font-weight: 600; font-size: 13px;
                    ">${safeConfirm}</button>
                </div>
            `;

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const finish = (value) => {
                resolve(value);
                this.close();
            };

            box.querySelector('#custom-alert-cancel').onclick = () => finish(false);
            box.querySelector('#custom-alert-ok').onclick = () => finish(true);
            overlay.onclick = (e) => {
                if (e.target === overlay) finish(false);
            };
        });
    },

    close() {
        const existing = document.getElementById('custom-alert-overlay');
        if (existing) {
            const box = existing.querySelector('div');
            if (box) {
                box.style.transform = 'translateY(20px)';
                box.style.opacity = '0';
            }
            setTimeout(() => existing.remove(), 300);
        }
    }
};
