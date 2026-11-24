// Department is optional in older profiles. Course is a free-text profile field.
const departmentCourses = {
    CCS: /\b(BSIT|BSCS|BSEMC|BSIS|computer science|information technology|information systems|entertainment and multimedia computing)\b/i,
    CEAS: /\b(BEED|BSED|BPEd|BTLEd|BAComm|education|communication)\b/i,
    CHTM: /\b(BSHM|BSTM|BSHRM|hospitality management|tourism management|hotel and restaurant management)\b/i,
    CAHS: /\b(BSN|BSM|BSMLS|BSMT(?=\s+medical)|nursing|midwifery|medical laboratory science|medical technology)\b/i,
    CBA: /\b(BSA|BSBA|BSAIS|BSMA|BSCA|accountancy|business administration|accounting information systems|customs administration|management accounting)\b/i
};
const colleges = {
    CCS:'College of Computer Studies', CEAS:'College of Education, Arts, and Sciences',
    CHTM:'College of Hospitality and Tourism Management', CAHS:'College of Allied Health Studies',
    CBA:'College of Business and Accountancy'
};
const reportDate = new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',year:'numeric',month:'short',day:'numeric'});
const studentView = { reports:[], period:'week', drill:{}, page:0, warning:'', ready:false };
function studentDepartment(person) {
    const normalize = value => String(value || '').replace(/[^a-z0-9]/gi,'').toLowerCase();
    const explicit = normalize(person?.department);
    for (const [code, name] of Object.entries(colleges)) {
        if ([normalize(code),normalize(name)].includes(explicit)) return code;
    }
    const course = String(person?.course || '').replace(/B\.\s*S\./gi,'BS').replace(/\bBS\s+(IT|CS|BA|HM|TM|N)\b/gi,'BS$1');
    return Object.keys(colleges).find(code => departmentCourses[code].test(course)) || 'Unspecified';
}
function reportPerson(user,id) {
    return {id, name:user?.full_name || (user?.username && '@'+user.username) || 'Name unavailable',
        dept:studentDepartment(user), course:user?.course?.trim() || 'Unspecified'};
}
function periodStart(period,now) {
    if (period === 'all') return -Infinity;
    const ph = new Date(now + 8*3600000);
    const day = period === 'month' ? 1 : ph.getUTCDate() - (ph.getUTCDay()+6)%7;
    return Date.UTC(ph.getUTCFullYear(),ph.getUTCMonth(),day)-8*3600000;
}
function studentSummary(now=Date.now()) {
    const start = periodStart(studentView.period,now);
    const rows = studentView.reports.filter(r => r.time >= start && r.time <= now);
    const earliest = rows.reduce((v,r)=>Math.min(v,r.time),Infinity);
    const first = Number.isFinite(start) ? start : earliest;
    const range = (Number.isFinite(first) ? reportDate.format(first)+' – ' : 'Through ')+reportDate.format(now)+' (PHT)';
    const users = new Map();
    for (const {target} of rows) {
        if (!target.id) continue;
        const row = users.get(target.id) || {...target,count:0};
        row.count++;
        users.set(target.id,row);
    }
    const ranked = [...users.values()].sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name));
    function groups(side) {
        const map = new Map(Object.keys(colleges).map(code=>[code,{code,count:0,courses:new Map()}]));
        for (const row of rows) {
            const {dept,course}=row[side];
            if (!map.has(dept)) map.set(dept,{code:dept,count:0,courses:new Map()});
            const group=map.get(dept);
            group.count++;
            group.courses.set(course,(group.courses.get(course)||0)+1);
        }
        return [...map.values()].sort((a,b)=>b.count-a.count || a.code.localeCompare(b.code));
    }
    return {range,total:rows.length,ranked,target:groups('target'),source:groups('source')};
}
function studentElement(tag,text) {
    const el=document.createElement(tag);
    if (text !== undefined) el.textContent=text;
    return el;
}
const chartNames={target:'Most reported departments',source:'Departments submitting the most reports'};
// Both department charts use the total for the selected period as their scale.
function departmentAxis(total) {
    const rough = Math.max(1,total/4);
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1,2,5,10].map(n=>n*magnitude).find(n=>n>=rough);
    return {step, max:Math.max(step,Math.ceil(total/step)*step)};
}

function pageOfFive(prefix, rows, requestedPage, changePage) {
    const pages = Math.max(1,Math.ceil(rows.length/5));
    const index = Math.max(0,Math.min(requestedPage,pages-1));
    const prev = document.getElementById(prefix+'Prev'), next = document.getElementById(prefix+'Next');
    prev.disabled = index === 0;
    next.disabled = index === pages-1;
    prev.onclick = ()=>changePage(index-1);
    next.onclick = ()=>changePage(index+1);
    document.getElementById(prefix+'Page').textContent = 'Page '+(index+1)+' of '+pages;
    return {index,rows:rows.slice(index*5,index*5+5)};
}
function drawStudentReports() {
    const s=studentSummary();
    document.getElementById('studentRange').textContent = studentView.ready
        ? s.range+' · '+s.total+' retained reports'+(studentView.warning?' · '+studentView.warning:'')
        : 'Report data unavailable.';
    document.getElementById('studentPdf').disabled=!studentView.ready;
    for (const side of Object.keys(chartNames)) {
        const panel=document.getElementById('student-'+side);
        panel.replaceChildren(studentElement('h3',chartNames[side]));
        const groups=s[side];
        const axis=departmentAxis(s.total);
        const chart=studentElement('div'),ticks=studentElement('div'),columns=studentElement('div');
        chart.className='department-plot'; ticks.className='axis-ticks';columns.className='dept-columns';
        columns.style.backgroundSize='100% '+(100*axis.step/axis.max)+'%';
        for(let v=axis.max;v>=0;v-=axis.step) ticks.append(studentElement('span',v));
        chart.append(ticks,columns);panel.append(chart);
        for(const g of groups) {
            const button=studentElement('button');
            button.className='dept-column';
            button.title=(colleges[g.code]||g.code)+' · '+g.count+' of '+s.total;
            button.setAttribute('aria-label',button.title+' reports. Show courses');
            button.setAttribute('aria-expanded',String(studentView.drill[side]===g.code));
            const bar=studentElement('i'),value=studentElement('b',g.count),caption=studentElement('span',g.code);
            bar.style.height=(100*g.count/axis.max)+'%';
            bar.append(value);button.append(bar,caption);
            button.onclick=()=>{
                studentView.drill[side]=studentView.drill[side]===g.code?null:g.code;
                drawStudentReports();
                [...panel.querySelectorAll('button')].find(b=>b.title===button.title)?.focus();
            };
            columns.append(button);
            if(studentView.drill[side]===g.code) {
                const details=studentElement('div'); details.className='course-detail';
                details.append(studentElement('b',button.title+' reports'));
                for (const [course,n] of [...g.courses].sort((a,b)=>b[1]-a[1])) details.append(studentElement('div',course+' · '+n));
                if (!g.count) details.append(studentElement('div','No reports in this period.'));
                panel.append(details);
            }
        }
    }
    const body=document.getElementById('studentRanks');
    body.replaceChildren();
    const slice=pageOfFive('rank',s.ranked,studentView.page,page=>{
        studentView.page=page;
        drawStudentReports();
        body.parentElement.parentElement.scrollTop=0;
    });
    studentView.page=slice.index;
    for (const row of slice.rows) {
        const tr=studentElement('tr');
        for (const text of [row.name,row.dept,row.course,row.count]) tr.append(studentElement('td',text));
        body.append(tr);
    }
    if (!body.children.length) {
        const tr=studentElement('tr'),cell=studentElement('td','No identifiable reported users in this period.');
        cell.colSpan=4; tr.append(cell);body.append(tr);
    }
}
function initStudentControls() {
    const periods=document.querySelectorAll('[data-student-period]');
    for (const button of periods) {
        button.onclick=()=>{
            studentView.period=button.dataset.studentPeriod;
            studentView.page=0;
            periods.forEach(choice=>choice.setAttribute('aria-pressed',String(choice===button)));
            drawStudentReports();
        };
    }
    document.getElementById('studentPdf').onclick=async e=>{
        const button=e.currentTarget;
        button.disabled=true;
        try {
            const s=studentSummary(), rows=[];
            for (const side of Object.keys(chartNames)) {
                for (const g of s[side]) {
                    rows.push([chartNames[side],g.code,'All courses',g.count]);
                    for (const [course,n] of g.courses) rows.push(['Course breakdown',g.code,course,n]);
                }
            }
            for (const u of s.ranked) rows.push([u.name,u.dept,u.course,u.count]);
            await loadReportLibrary('/JS/vendor/pdf-lib.min.js');
            const pdf=await reportPdf({title:'Student reports by department',updated:s.range+(studentView.warning?' | Partial data':''),headers:['Measure / reported user','Department','Course','Reports'],rows});
            const doc=await PDFLib.PDFDocument.load(await pdf.arrayBuffer());
            const page=doc.insertPage(0,[842,595]);
            page.drawText('GC FitShare | Student reports',{x:34,y:543,size:23});
            page.drawText(s.range+'   |   '+s.total+' retained reports',{x:34,y:513,size:12});
            if(studentView.warning) page.drawText(studentView.warning,{x:34,y:490,size:10});
            Object.keys(chartNames).forEach((side,i)=>{
                const x=34+i*395;
                page.drawText(chartNames[side],{x,y:445,size:15});
                const axis=departmentAxis(s.total),base=165,height=218,left=x+30;
                for(let v=0;v<=axis.max;v+=axis.step) {
                    const y=base+height*v/axis.max;
                    page.drawLine({start:{x:left,y},end:{x:left+315,y},thickness:.5,color:PDFLib.rgb(.75,.8,.8)});
                    page.drawText(String(v),{x,y:y-3,size:9});
                }
                const slot=315/s[side].length;
                s[side].forEach((g,j)=>{
                    const cx=left+slot*(j+.5),h=height*g.count/axis.max;
                    if(h)page.drawRectangle({x:cx-12,y:base,width:24,height:h,color:side==='target'?PDFLib.rgb(.04,.61,.54):PDFLib.rgb(.2,.45,.8)});
                    page.drawText(String(g.count),{x:cx-4,y:base+h+5,size:10});
                    page.drawText(g.code,{x:cx-g.code.length*2.3,y:base-16,size:9});
                });
            });
            const url=URL.createObjectURL(new Blob([await doc.save()],{type:'application/pdf'}));
            const a=studentElement('a');a.href=url;a.download='GC-FitShare-student-reports-'+studentView.period+'.pdf';a.click();
            setTimeout(()=>URL.revokeObjectURL(url),30000);
        } catch(err){showAppAlert('Download failed',err.message,'error');}
        finally {button.disabled=false;}
    };
}
let profilesHaveDepartment=true;
async function analyticsProfiles() {
    const fields='id,username,full_name,course';
    if (profilesHaveDepartment) {
        try {return await analyticsRows('users',fields+',department');}
        catch(e){if (!/42703|PGRST204/.test(e.code) && !/department.*does not exist/i.test(e.message)) throw e;}
        profilesHaveDepartment=false;
    }
    return analyticsRows('users',fields);
}
async function prepareStudentReports(flags,accounts,people) {
    const userMap=new Map((people||[]).map(u=>[u.id,u]));
    const posts=new Map();
    const human=(flags||[]).filter(r=>!String(r.flagged_by||'').toLowerCase().includes('ai'));
    const ids=[...new Set(human.map(r=>r.post_id).filter(Boolean))];
    let partial=[flags,accounts,people].includes(null);
    for(let i=0;i<ids.length;i+=100){
        const {data,error}=await supabase.from('posts').select('id,user_id').in('id',ids.slice(i,i+100));
        if(error){partial=true;continue;}
        for(const p of data)posts.set(p.id,p.user_id);
    }
    const person=id=>reportPerson(userMap.get(id),id);
    studentView.reports=[...human.map(r=>({time:Date.parse(r.created_at),target:person(posts.get(r.post_id)),source:person(r.flagged_by)})),
        ...(accounts||[]).map(r=>({time:Date.parse(r.created_at),target:person(r.reported_user_id),source:person(r.reporter_id)}))];
    studentView.ready=Boolean(flags||accounts);
    studentView.warning=partial?'Some report data is unavailable.':'';
    drawStudentReports();
    return userMap;
}
