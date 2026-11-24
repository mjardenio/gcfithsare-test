// Reports use the signed-in admin client and fetch every matching page on demand.
const reportLibraries = new Map();
function loadReportLibrary(path) {
    if (!reportLibraries.has(path)) {
        reportLibraries.set(path, new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = path; 
            script.onload = resolve;
            script.onerror = () => { 
                reportLibraries.delete(path);
                script.remove();
                reject(new Error('Report library could not load. Please retry.'));
            };
            document.head.append(script);
        }));
    }
    return reportLibraries.get(path);
}

async function collectToolReport(tool) {
    const users = () => analyticsRows('users', 'id,full_name,username,email,course');
    const apps = () => analyticsRows('expert_applications', '*');
    const directory = async () => new Map((await users()).map(person => [person.id, person]));
    const identify = (map, id) => map.get(id)?.full_name || map.get(id)?.username || id || '';
    const latest = (rows, key) => rows.sort((a, b) => String(b[key] || '').localeCompare(String(a[key] || '')));
    const table = (headers, rows) => ({ headers, rows });
    if (tool === 'summary') {
        const { metrics, updated } = dashboardReport;
        return { headers: ['Category', 'Metric', 'Count', 'Snapshot UTC'], updated,
            rows: metrics.map(m => [m.group, m.label, m.count ?? 'Unavailable', updated]) };
    }
    if (tool === 'total-users') {
        const rows = await users();
        rows.sort((a,b) => String(a.full_name || a.username || '').localeCompare(b.full_name || b.username || ''));
        return table(['Name','Username','Course','User ID'], rows.map(u => [u.full_name,u.username,u.course,u.id]));
    }
    if (tool === 'expert-apps' || tool === 'expert-history') {
        const history = tool === 'expert-history';
        const [records, people] = await Promise.all([apps(), directory()]);
        const rows = latest(records.filter(a => isExpertApplicationDecidedApproved(a) === history), 'submitted_at');
        return table(['Applicant','Course','Email','Status','Submitted','Motivation','Credentials'], rows.map(a => [
            a.full_name || identify(people,a.user_id), a.course || people.get(a.user_id)?.course, people.get(a.user_id)?.email,
            a.status || 'pending', a.submitted_at, expertWhyText(a), a.credentials
        ]));
    }
    if (tool === 'active-experts') {
        const [people, records] = await Promise.all([
            analyticsRows('users','id,full_name,username,email,course,expert_title,is_expert', q => q.eq('is_expert',true)), apps()
        ]);
        const rows = mergeLatestApprovedApplications(people, records);
        return table(['Name','Username','Email','Course','Expert title','Motivation','Credentials'], rows.map(u => [
            u.full_name,u.username,u.email,u.course,u.expert_title,u.expertApplication && expertWhyText(u.expertApplication),
            u.expertApplication?.credentials
        ]));
    }
    if (tool === 'pending-posts') {
        const [posts, people] = await Promise.all([
            analyticsRows('posts','id,user_id,title,body,category,created_at', q => q.eq('status','pending')), directory()
        ]);
        return table(['Post title','Author','Category','Submitted','Content'], latest(posts,'created_at').map(p =>
            [p.title,identify(people,p.user_id),p.category,p.created_at,p.body]));
    }
    if (tool === 'reports') {
        const [flags, people] = await Promise.all([analyticsRows('flagged_content','id,post_id,flagged_by,reason,status,created_at'),directory()]);
        const rows = latest(flags.filter(isUserReportModerationQueueRow), 'created_at');
        const ids = [...new Set(rows.map(r => r.post_id).filter(Boolean))];
        const titles = new Map();
        for (let start = 0; start < ids.length; start += 80) {
            const {data,error} = await supabase.from('posts').select('id,title').in('id',ids.slice(start,start+80));
            if (error) throw error;
            for (const post of data) titles.set(post.id,post.title);
        }
        return table(['Post title','Post ID','Reported by','Reason','Status','Reported'], rows.map(r =>
            [titles.get(r.post_id),r.post_id,identify(people,r.flagged_by),r.reason,r.status,r.created_at]));
    }
    if (tool === 'reported-accounts') {
        const [rows, people] = await Promise.all([analyticsRows('reported_accounts','id,reported_user_id,reporter_id,reason,details,status,created_at'),directory()]);
        return table(['Account','Reported by','Reason','Details','Status','Reported'],latest(rows,'created_at').map(r =>
            [identify(people,r.reported_user_id),identify(people,r.reporter_id),r.reason,r.details,r.status,r.created_at]));
    }
    if (tool === 'ai-blocks') {
        const [rows,people] = await Promise.all([analyticsRows('ai_moderation_attempts','id,user_id,title_preview,reason,created_at'),directory()]);
        return table(['Post preview','User','Block reason','Recorded'],latest(rows,'created_at').map(r =>
            [r.title_preview,identify(people,r.user_id),r.reason,r.created_at]));
    }
    throw new Error('Unknown report.');
}

function reportCsv({headers, rows}) {
    function cell(value) {
        let text = String(value ?? '');
        if (typeof value === 'string' && /^(?:\s*[=+@-]|[\t\r\n])/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g,'""') + '"';
    }
    return new Blob(['\uFEFF', [headers,...rows].map(row => row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
}

function initAdminExports() {
    const formats = ['csv','pdf','xlsx'];
    for (const [tool,id] of Object.entries(toolModalMap)) {
        const modal = document.getElementById(id);
        const controls = document.createElement('div');
        controls.className = 'report-actions tool-exports';
        for (const format of formats) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Download ' + (format === 'xlsx' ? 'Excel' : format.toUpperCase());
            button.dataset.toolFormat = format;
            controls.append(button);
        }
        modal.querySelector('.modal-body').prepend(controls);
        controls.addEventListener('click', event => {
            const format = event.target.dataset.toolFormat;
            if (format) exportAdminReport(tool, modal.querySelector('h2').textContent, format, controls);
        });
    }
    const controls = document.querySelector('.report-heading .report-actions');
    controls.addEventListener('click', event => {
        const format = event.target.dataset.reportFormat;
        if (format && dashboardReport) exportAdminReport('summary','Dashboard analytics',format,controls);
    });
}

async function exportAdminReport(tool, title, format, controls) {
    if (controls.getAttribute('aria-busy') === 'true') return;
    controls.setAttribute('aria-busy','true');
    const buttons = controls.querySelectorAll('button');
    buttons.forEach(b => { b.disabled = true; });
    try {
        const report = await collectToolReport(tool);
        report.title = title;
        report.updated ??= new Date().toISOString();
        let blob;
        if (format === 'csv') blob = reportCsv(report);
        if (format === 'pdf') {
            await loadReportLibrary('/JS/vendor/pdf-lib.min.js');
            blob = await reportPdf(report);
        }
        if (format === 'xlsx') {
            await loadReportLibrary('/JS/vendor/jszip.min.js');
            blob = await reportWorkbook(report);
        }
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = 'GC-FitShare-' + tool + '-' + report.updated.replace(/[:.]/g,'-') + '.' + format;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url),30000);
    } catch (error) {
        showAppAlert('Download failed', 'Could not generate the report. ' + (error.message || 'Please retry.'), 'error');
    } finally {
        controls.removeAttribute('aria-busy');
        buttons.forEach(b => { b.disabled = false; });
    }
}

async function reportWorkbook({ title, updated, headers, rows }) {
    const response = await fetch('/ASSETS/admin-report-template.xlsx');
    if (!response.ok) throw new Error('Workbook template could not load.');
    const book = await JSZip.loadAsync(await response.arrayBuffer());
    const xml = value => String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const column = index => String.fromCharCode(65 + index);
    const last = column(headers.length - 1);
    function rowXml(values, number, style, height) {
        const cells = values.map((value, index) => {
            const ref = column(index) + number;
            if (typeof value === 'number') return '<c r="' + ref + '" s="' + style + '"><v>' + value + '</v></c>';
            const text = String(value ?? '');
            if (text.length > 32767) throw new Error('A record exceeds the Excel cell limit. Use CSV or PDF for this report.');
            return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
                xml(text) + '</t></is></c>';
        }).join('');
        return '<row r="' + number + '"' + (height ? ' ht="' + height + '" customHeight="1"' : '') + '>' + cells + '</row>';
    }
    const widths = headers.map((header,i) => rows.reduce((width,row) =>
        Math.max(width, Math.min(52, String(row[i] ?? '').length + 2)), Math.max(16,header.length+2)));
    const cols = widths.map((width,i) => '<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+width+'" customWidth="1"/>').join('');
    const table = [
        rowXml(['GC FitShare | ' + title],1,1,29),
        rowXml([updated + '   |   ' + rows.length + ' records'],2,2,21),
        rowXml(headers,3,3,24),
        ...rows.map((row,i) => rowXml(row,i+4,4+i%2))
    ].join('');
    book.file('xl/worksheets/sheet1.xml',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        '<cols>'+cols+'</cols><sheetData>'+table+'</sheetData><autoFilter ref="A3:'+last+(rows.length+3)+'"/>' +
        '<mergeCells count="2"><mergeCell ref="A1:'+last+'1"/><mergeCell ref="A2:'+last+'2"/></mergeCells></worksheet>');
    return book.generateAsync({type:'blob',compression:'DEFLATE',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}

async function reportPdf({ title, updated, headers, rows }) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle('GC FitShare | ' + title);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const white = rgb(1,1,1), ink = rgb(.09,.17,.17), teal = rgb(.03,.37,.34);
    const width = 842, height = 595, margin = 28, lineHeight = 12, bottom = 36;
    const colWidth = (width - 2*margin) / headers.length;
    let page, y;
    // Keep normal text selectable. Render lines containing glyphs outside the
    // built-in PDF font with the browser's Unicode font fallback.
    let context;
    function measure(text) {
        try { return font.widthOfTextAtSize(text,9); }
        catch {
            context ??= document.createElement('canvas').getContext('2d');
            context.font = '9px sans-serif';
            return context.measureText(text).width;
        }
    }
    async function drawLine(text,x,baseline) {
        try { font.encodeText(text); }
        catch {
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil((colWidth-8)*3);
            canvas.height = 48;
            const ctx = canvas.getContext('2d');
            ctx.scale(3,3); ctx.font = '9px sans-serif'; ctx.fillStyle = '#172b2b';
            ctx.fillText(text,0,11,colWidth-8);
            const image = await doc.embedPng(canvas.toDataURL('image/png'));
            page.drawImage(image,{x,y:baseline-5,width:canvas.width/3,height:16});
            return;
        }
        page.drawText(text,{x,y:baseline,font,size:9,color:ink});
    }
    function wrap(value) {
        const lines = [];
        for (const paragraph of String(value ?? '').replace(/\r\n?/g,'\n').replace(/\t/g,' ').split('\n')) {
            let line = '';
            for (const word of paragraph.split(/ +/)) {
                const next = line ? line+' '+word : word;
                if (measure(next) <= colWidth-10) { line=next; continue; }
                if (line) lines.push(line);
                line='';
                for (const char of word) {
                    if (line && measure(line+char)>colWidth-10) { lines.push(line); line=''; }
                    line+=char;
                }
            }
            lines.push(line);
        }
        return lines;
    }
    function newPage() {
        page = doc.addPage([width,height]);
        page.drawText('GC FITSHARE',{x:margin,y:height-32,font:bold,size:10,color:teal});
        page.drawText(title,{x:margin,y:height-58,font:bold,size:21,color:ink});
        page.drawText(updated+'    |    '+rows.length+' records',{x:margin,y:height-77,font,size:10,color:ink});
        y=height-96;
        page.drawRectangle({x:margin,y:y-24,width:width-margin*2,height:24,color:teal});
        headers.forEach((h,i)=>page.drawText(h,{x:margin+i*colWidth+5,y:y-16,font:bold,size:10,color:white}));
        y-=24;
    }
    newPage();
    if (!rows.length) page.drawText('No matching records.',{x:margin+5,y:y-22,font,size:11,color:ink});
    for (const [index,row] of rows.entries()) {
        const columns = row.map(wrap);
        const total = Math.max(...columns.map(lines=>lines.length));
        let offset=0;
        const rowHeight=total*lineHeight+8;
        if (rowHeight <= height-120-bottom && y-rowHeight < bottom) newPage();
        while (offset<total) {
            if (y-bottom < lineHeight+8) newPage();
            const count=Math.min(total-offset,Math.floor((y-bottom-8)/lineHeight));
            const bandHeight=count*lineHeight+8;
            page.drawRectangle({x:margin,y:y-bandHeight,width:width-2*margin,height:bandHeight,
                color:index%2 ? rgb(.93,.97,.96) : white,borderWidth:.4,borderColor:rgb(.8,.85,.84)});
            for (const [i,lines] of columns.entries()) {
                for (let j=0;j<count && offset+j<lines.length;j++) {
                    await drawLine(lines[offset+j],margin+i*colWidth+5,y-13-j*lineHeight);
                }
            }
            y-=bandHeight; offset+=count;
        }
    }
    doc.getPages().forEach((p,i)=>p.drawText('Page '+(i+1)+' of '+doc.getPageCount(),
        {x:width-110,y:16,font,size:9,color:ink}));
    return new Blob([await doc.save()],{type:'application/pdf'});
}
