import React, { useMemo, useState } from "react";
// --- Optional realtime sync (Firebase) ---
import { initializeApp } from "firebase/app";
import { getFirestore, doc, onSnapshot, setDoc } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

/**
 * Aquamore Builder — LITE
 * Obiettivi: file più corto ma stesso risultato principale.
 * - Editor unico con [MAIN] per separare pre/post dal lavoro centrale
 * - Tre campi per il MAIN (Mez/Vel/Sal) con fallback comune
 * - Parser compatto: metri, Zone (A1..C3,D,FH2O), Tipologie (Kick/Pull/UW/Scull/Drill/Swim), Materiale
 * - Statistiche rapide + approfondite
 * - Link preview dal testo
 * - Export TSV + Stampa PDF essenziali
 * Rimosso: Firebase/Login, barra settimanale, modelli tempo complessi (stimatore minuti opzionale semplificato)
 */

// ====== Costanti compatte ======
// --- Firebase minimal config (inserisci le tue chiavi per abilitare la condivisione multi‑device) ---
const firebaseConfig = {
  apiKey: "AIzaSyATsgluuZwcwPbB22BlR3Foa5q-5c-AJW8",
  authDomain: "swimming-session-builder-2.firebaseapp.com",
  projectId: "swimming-session-builder-2",
  storageBucket: "swimming-session-builder-2.firebasestorage.app",
  messagingSenderId: "624708544085",
  appId: "1:624708544085:web:635ec3b5293a85354616dc",
  measurementId: "G-4R9MHETNST"
};
let fbAppInited = false; let fbEnabled = false; let db:any=null; let auth:any=null;
function ensureFirebase(){
  if(fbAppInited) return fbEnabled;
  try{
    if(!firebaseConfig.apiKey) { fbAppInited=true; fbEnabled=false; return false; }
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    onAuthStateChanged(auth, (u)=>{ if(!u) signInAnonymously(auth).catch(()=>{}); });
    fbAppInited=true; fbEnabled=true; return true;
  }catch{ fbAppInited=true; fbEnabled=false; return false; }
}
const getParam = (k:string)=> new URLSearchParams(window.location.search).get(k);
const ZONES = ["A1","A2","B1","B2","C1","C2","C3","D","FH2O"] as const; type Zone = typeof ZONES[number];
const DRILLS = ["Kick","Pull","UW","Scull","Drill","Swim"] as const; type Drill = typeof DRILLS[number];
const GEAR = ["Board","Fins","Paddles","Snorkel","Band"] as const; type Gear = typeof GEAR[number];
const LABELS: Record<Drill,string> = { Kick:"Gambe", Pull:"Braccia", UW:"Sub", Scull:"Remate", Drill:"Tecnica", Swim:"Completo" };

// ====== Normalizza & Tokenize ======
const norm=(s:string)=> s.replace(/\r\n?/g,"\n").replace(/\u00D7/g,"x").replace(/[\u2013\u2014]/g,"-").replace(/[\t ]+/g," ").trim();
function toks(input:string){ const re=/(\d+\.?\d*)|x|[()/:]|A1|A2|B1|B2|C1|C2|C3|D|FH2O|\n|@|,|;|\[|\]|-|\+|\*|%|[a-zA-ZàèéìòùÀÈÉÌÒÙçÇ]+/g; const out:string[]=[]; let m:RegExpExecArray|null; const s=norm(input); while((m=re.exec(s))) out.push(m[0]); return out; }

// ====== Alias compatti ======
const styleAlias=(w:string)=>{ const t=(w||"").toLowerCase(); if(["uw","underwater","sub","ow"].includes(t)) return "UW"; if(["kick","gambe","kickboard"].includes(t)) return "Kick"; if(["pull","braccia","pullbuoy"].includes(t)) return "Pull"; if(["scull","sculling","remata","remate"].includes(t)) return "Scull"; if(["drill","tecnica","tech","technique"].includes(t)) return "Drill"; return ""; };
const gearAlias=(w:string)=>{ const t=(w||"").toLowerCase(); if(["board","tavola"].includes(t)) return "Board"; if(["fins","pinne"].includes(t)) return "Fins"; if(["paddles","palette"].includes(t)) return "Paddles"; if(["snorkel","boccaglio","snorker"].includes(t)) return "Snorkel"; if(["band","elastico"].includes(t)) return "Band"; return ""; };

// ====== Preprocess moltiplicatori nidificati ======
function expandMulti(src:string){
  const lines = src.replace(/\r\n?/g,"\n").split("\n"); const out:string[]=[];
  for(let i=0;i<lines.length;){ const L=lines[i];
    const mb=L.match(/^\s*(\d+)\s*x\s*(BEGIN|\{)\s*$/i); if(mb){ const n=+mb[1]; let j=i+1, buf:string[]=[]; while(j<lines.length && !/^\s*(END|\})\s*$/i.test(lines[j])){ buf.push(lines[j]); j++; } if(j<lines.length) j++; out.push(`${n}x( ${buf.join("\n")} )`); i=j; continue; }
    const ma=L.match(/^\s*(\d+)\s*x\s*$/i); if(ma){ const n=+ma[1]; let j=i+1, buf:string[]=[]; while(j<lines.length && lines[j].trim()!==''){ buf.push(lines[j]); j++; } out.push(`${n}x( ${buf.join("\n")} )`); if(j<lines.length && lines[j].trim()==='') out.push(''); i=j+1; continue; }
    out.push(L); i++; }
  return out.join("\n");
}

// ====== Stats ======
export type Stats = { meters:number; perZone:Record<Zone,number>; perDrill:Record<Drill,number>; perGear:Record<Gear,number> };
const empty=():Stats=>({ meters:0, perZone:Object.fromEntries(ZONES.map(z=>[z,0])) as any, perDrill:Object.fromEntries(DRILLS.map(d=>[d,0])) as any, perGear:Object.fromEntries(GEAR.map(g=>[g,0])) as any });
const isRep=(t:string[],i:number)=> t[i+1]==="x" && t[i+2]==="("; const isTime=(t:string[],i:number)=> t[i+1]===":";

export function parseStats(text:string):Stats{
  const T=toks(expandMulti(text||"")); const S=empty(); const mult:number[]=[]; let hang=1;
  for(let i=0;i<T.length;i++){
    if(T[i]==='\n' && T[i+1]==='\n'){ hang=1; continue; }
    if(/^\d/.test(T[i]||'') && T[i+1]==='x' && T[i+2]==='\n'){ hang=parseFloat(T[i])||1; i+=1; continue; }
    const tk=T[i]; if(/^\d/.test(tk) && isRep(T,i)){ mult.push(parseFloat(tk)); i+=1; continue; }
    if(tk==='(') continue; if(tk===')'){ mult.pop(); continue; }
    if(/^\d/.test(tk)){
      if(isTime(T,i)) continue; if(T[i+1]==='x' && /^\d/.test(T[i+2]||'')) continue;
      const d=parseFloat(tk); const outer=mult.reduce((a,b)=>a*b,1)||1; let local=1; if(T[i-1]==='x' && /^\d/.test(T[i-2]||'')) local=parseFloat(T[i-2]); const add=d*outer*local*hang; S.meters+=add;
      // Zona immediata o precedente; override con "passo", "passo gara", "pg" o formato 200p (p subito dopo)
      let z:Zone = (ZONES as readonly string[]).includes((T[i+1]||'') as Zone) ? T[i+1] as Zone : (ZONES as readonly string[]).includes((T[i-1]||'') as Zone) ? T[i-1] as Zone : 'A1';
      let race=false; const next=(T[i+1]||'').toLowerCase(); if(next==='p') race=true; // 200p
      if(!race){ for(let k=i+1;k<T.length && T[k]!=="\n";k++){ if(/^(passo|passo\s*gara|pg)$/i.test(T[k])){ race=true; break; } } }
      if(!race){ for(let k=i-1;k>=0 && T[k]!=="\n";k--){ if(/^(passo|passo\s*gara|pg)$/i.test(T[k])){ race=true; break; } } }
      if(race) z='D'; S.perZone[z]+=add;
      // Drill (solo stessa riga, fino a \n)
      const seek=(dir:1|-1)=>{ let steps=0, idx=i; while(steps<6){ idx+=dir; const t=T[idx]; if(t===undefined || t==='\n') break; const v=styleAlias(t); if(v) return v as Drill; steps++; } return "" as ""; };
      const dB=seek(-1), dF=seek(1); const drill=(dB||dF||'Swim') as Drill; S.perDrill[drill]+=add;
      // Gear (raccoglie su entrambi i lati)
      const gSet=new Set<Gear>(); for(const dir of [-1,1] as const){ let steps=0, idx=i; while(steps<6){ idx+=dir; const t=T[idx]; if(t===undefined||t==='\n') break; const g=gearAlias(t) as Gear|""; if(g) gSet.add(g); steps++; } } gSet.forEach(g=> S.perGear[g]+=add);
    }
  }
  if(S.meters===0){ const rx=/\b(\d{2,4})\b\s*(A1|A2|B1|B2|C1|C2|C3|D|FH2O)?/gi; let m:RegExpExecArray|null; while((m=rx.exec(text))){ const d=parseFloat(m[1]); const z=(m[2] as Zone)||'A1'; S.meters+=d; S.perZone[z]+=d; S.perDrill.Swim+=d; } }
  return S;
}

// ====== Editor split ======
const DEFAULT_EDITOR=`\n\n\n\n\n[MAIN]\n\n`;
const split=(src:string)=>{ const has=src.includes('[MAIN]'); if(!has) return {pre:src.trim(), post:'', has:false}; const [pre,post]=src.split('[MAIN]'); return { pre:pre.trim(), post:(post||'').trim(), has:true }; };

// ====== Link preview ======
function extractLinks(text:string){ const out:{href:string;label:string}[]=[]; const seen=new Set<string>(); const md=/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g; let m:RegExpExecArray|null; while((m=md.exec(text))){ const href=m[2]; const label=m[1]||href; if(!seen.has(href)){ out.push({href,label}); seen.add(href);} } const url=/(https?:\/\/[^\s)]+)|(\bwww\.[^\s)]+\b)/g; let u:RegExpExecArray|null; while((u=url.exec(text))){ const raw=u[1]||u[2]; if(!raw) continue; const href=raw.startsWith('http')?raw:`https://${raw}`; if(seen.has(href)) continue; out.push({href,label:href}); seen.add(href);} return out; }

// ====== Helpers settimana & data ======
const fmt = (d:Date)=>{ const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; };
const addDays = (date:Date, n:number)=>{ const d=new Date(date); d.setDate(d.getDate()+n); return d; };
const startOfWeekMon = (d:Date)=>{ const dd=new Date(d); const day=(dd.getDay()+6)%7; dd.setDate(dd.getDate()-day); dd.setHours(0,0,0,0); return dd; };

// ====== UI ======
function Stat({title, s}:{title:string; s:{pre:Stats;main:Stats;post:Stats;total:number}}){
  const n=(x:number)=>x.toLocaleString();
  const sumZ=(z:Zone)=> (s.pre.perZone[z]||0)+(s.main.perZone[z]||0)+(s.post.perZone[z]||0);
  const sumD=(d:Drill)=> (s.pre.perDrill[d]||0)+(s.main.perDrill[d]||0)+(s.post.perDrill[d]||0);
  const sumG=(g:Gear)=> (s.pre.perGear[g]||0)+(s.main.perGear[g]||0)+(s.post.perGear[g]||0);
  return (
    <div className="rounded-2xl border p-3 text-sm space-y-2">
      <div className="font-medium">{title}</div>
      <div className="flex items-center justify-between"><span className="text-gray-500">Pre</span><span className="font-mono">{n(s.pre.meters)} m</span></div>
      <div className="flex items-center justify-between"><span className="text-gray-500">Main</span><span className="font-mono">{n(s.main.meters)} m</span></div>
      <div className="flex items-center justify-between"><span className="text-gray-500">Post</span><span className="font-mono">{n(s.post.meters)} m</span></div>
      <div className="pt-2 border-t flex items-center justify-between"><span className="font-semibold">Totale</span><span className="font-mono">{n(s.total)} m</span></div>
      {/* Zone */}
      <div className="pt-2 border-t grid grid-cols-3 gap-x-2 gap-y-1 text-[12px]">
        {ZONES.map(z=> (
          <div key={z} className="flex items-center justify-between"><span className="text-gray-500">{z}</span><span className="font-mono">{n(Math.round(sumZ(z)))}</span></div>
        ))}
      </div>
      {/* Tipologie */}
      <div className="pt-2 border-t grid grid-cols-3 gap-x-2 gap-y-1 text-[12px]">
        {DRILLS.map(d=> (
          <div key={d} className="flex items-center justify-between"><span className="text-gray-500">{LABELS[d]}</span><span className="font-mono">{n(Math.round(sumD(d)))}</span></div>
        ))}
      </div>
      {/* Materiale */}
      <div className="pt-2 border-t grid grid-cols-3 gap-x-2 gap-y-1 text-[12px]">
        {GEAR.map(g=> (
          <div key={g} className="flex items-center justify-between"><span className="text-gray-500">{g}</span><span className="font-mono">{n(Math.round(sumG(g)))}</span></div>
        ))}
      </div>
    </div>
  );
}




function GroupBox({label,value,onChange}:{label:string;value:string;onChange:(v:string)=>void}){ return (
  <div>
    <div className="flex items-centered justify-between mb-1"><span className="font-medium">{label}</span></div>
    <textarea value={value} onChange={(e)=>onChange(e.target.value)} rows={7} className="w-full border rounded-2xl p-3 text-base leading-6" placeholder={`Esempi (IT/EN):\n8x50 gambe @1:00\n6x100 braccia\n2x BEGIN\n200 pull @3:00\n4x50 kick @1:00\nEND`}/>
  </div>
); }

// ====== App ======
export default function App(){
  // --- Sync state ---
  const [connected, setConnected] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const docId = getParam('doc');
  // Titolo + data/ora + settimana (LITE)
  const [sessionTitle, setSessionTitle] = useState("");
  const [dateTime, setDateTime] = useState(()=>{
    try{
      const last = localStorage.getItem('ab_lite:lastDate');
      const base = last ? new Date(last) : new Date();
      const d=new Date(base); d.setHours(18,0,0,0);
      return `${fmt(base)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }catch{
      const d=new Date(); d.setHours(18,0,0,0);
      return `${fmt(new Date())}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }
  });
  const [weekAnchor,setWeekAnchor]=useState(()=>{
    try{
      const last = localStorage.getItem('ab_lite:lastDate');
      const base = last ? new Date(last) : new Date();
      return startOfWeekMon(base);
    }catch{ return startOfWeekMon(new Date()); }
  });
  // Sospendi il salvataggio durante il cambio giorno/caricamento
  const [suspendSave, setSuspendSave] = useState(true);
  // abilita sync se possibile
  React.useEffect(()=>{
    const ro = getParam('ro'); setReadOnly(ro==='1' || ro==='true');
    const ok = ensureFirebase(); if(!ok || !docId){ setConnected(false); setSuspendSave(false); return; }
    try{
      const ref = doc(db, 'ab_shared_lite', docId!);
      const unsub = onSnapshot(ref, (snap)=>{
        if(!snap.exists()) { setConnected(true); return; }
        const d:any = snap.data();
        setSuspendSave(true);
        if(d.sessionTitle!==undefined) setSessionTitle(d.sessionTitle);
        if(d.dateTime!==undefined) setDateTime(d.dateTime);
        if(d.weekAnchorISO){ try{ setWeekAnchor(startOfWeekMon(new Date(d.weekAnchorISO))); }catch{} }
        if(d.editor!==undefined) setEditor(d.editor);
        if(d.mez!==undefined) setMez(d.mez);
        if(d.vel!==undefined) setVel(d.vel);
        if(d.sal!==undefined) setSal(d.sal);
        setConnected(true);
        setSuspendSave(false);
      });
      return ()=>unsub();
    }catch{ setConnected(false); setSuspendSave(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Editor testi
  const [editor,setEditor]=useState(DEFAULT_EDITOR);
  const [mez,setMez]=useState(""); const [vel,setVel]=useState(""); const [sal,setSal]=useState("");

  // Persist per giorno + utilità settimana
  const dateISO = useMemo(()=> (dateTime.split('T')[0]||fmt(new Date())), [dateTime]);
  React.useEffect(()=>{
    if(suspendSave) return; // non salvare durante navigazione/caricamento
    const key = `ab_lite:${dateISO}`;
    const payload = { editor, mez, vel, sal, sessionTitle, dateTime };
    // Local backup
    try{
      localStorage.setItem(key, JSON.stringify(payload));
      localStorage.setItem('ab_lite:lastDate', dateISO);
    }catch{}
    // Realtime sync (se disponibile)
    try{
      if(fbEnabled && docId && !readOnly){
        const ref = doc(db, 'ab_shared_lite', docId);
        setDoc(ref, { ...payload, weekAnchorISO: fmt(weekAnchor), updatedAt: Date.now() }, { merge:true }).catch(()=>{});
      }
    }catch{}
  },[editor,mez,vel,sal,sessionTitle,dateTime,weekAnchor,readOnly,suspendSave,docId]);

  const days = useMemo(()=>{ const start=new Date(weekAnchor); return Array.from({length:7},(_,i)=> addDays(start,i)); },[weekAnchor]);

  // Totali settimana (Mez/Vel/Sal) calcolati sulle card
  const weeklyTotals = useMemo(()=>{
    let mez=0, vel=0, sal=0; try{
      for(const d of days){ const iso=fmt(d); const s=getDaySummary(iso); mez+=s.mez; vel+=s.vel; sal+=s.sal; }
    }catch{}
    return { mez, vel, sal };
  }, [days, editor, mez, vel, sal, sessionTitle]);

  // riallinea automaticamente la settimana alla data selezionata
  React.useEffect(()=>{ try{ setWeekAnchor(startOfWeekMon(new Date(dateISO))); }catch{} }, [dateISO]);

  // Carica i dati del giorno quando si cambia la data (senza copiare la seduta corrente)
  React.useEffect(()=>{
    const key = `ab_lite:${dateISO}`;
    setSuspendSave(true);
    try{
      const raw = localStorage.getItem(key);
      if(raw){
        const d = JSON.parse(raw);
        setEditor(d.editor ?? DEFAULT_EDITOR);
        setMez(d.mez ?? "");
        setVel(d.vel ?? "");
        setSal(d.sal ?? "");
        setSessionTitle(d.sessionTitle ?? "");
      } else {
        setEditor(DEFAULT_EDITOR);
        setMez(""); setVel(""); setSal("");
        setSessionTitle("");
      }
    }catch{}
    finally{ setSuspendSave(false); }
  }, [dateISO]);

  function getDaySummary(iso:string){
    try{
      const raw = localStorage.getItem(`ab_lite:${iso}`);
      if(!raw) return { mez:0, vel:0, sal:0 };
      const d = JSON.parse(raw);
      const p = split(d.editor||"");
      if(!p.has){
        const all = parseStats(d.editor||""); const tot=all.meters; return { mez:tot, vel:tot, sal:tot };
      }
      const pre = parseStats(p.pre); const post = parseStats(p.post);
      const commonMain = (d.mez||"") || (d.vel||"") || (d.sal||"") || "";
      const mMez = parseStats((d.mez||"") || commonMain);
      const mVel = parseStats((d.vel||"") || commonMain);
      const mSal = parseStats((d.sal||"") || commonMain);
      const base = pre.meters + post.meters;
      return { mez: base + mMez.meters, vel: base + mVel.meters, sal: base + mSal.meters };
    }catch{ return { mez:0, vel:0, sal:0 }; }
  }

  const links = useMemo(()=> extractLinks(editor), [editor]);
  const parts = useMemo(()=> split(editor), [editor]);
  const common = useMemo(()=> (mez||vel||sal||"").trim(), [mez,vel,sal]);
  const mainM = useMemo(()=> parts.has?((mez||"").trim()||common):"", [parts,mez,common]);
  const mainV = useMemo(()=> parts.has?((vel||"").trim()||common):"", [parts,vel,common]);
  const mainS = useMemo(()=> parts.has?((sal||"").trim()||common):"", [parts,sal,common]);

  const Spre = useMemo(()=> parseStats(parts.pre), [parts]);
  const Spost= useMemo(()=> parseStats(parts.post), [parts]);
  const SM   = useMemo(()=> parseStats(mainM), [mainM]);
  const SV   = useMemo(()=> parseStats(mainV), [mainV]);
  const SS   = useMemo(()=> parseStats(mainS), [mainS]);

  const boxM = { pre:Spre, main:SM, post:Spost, total:Spre.meters+SM.meters+Spost.meters };
  const boxV = { pre:Spre, main:SV, post:Spost, total:Spre.meters+SV.meters+Spost.meters };
  const boxS = { pre:Spre, main:SS, post:Spost, total:Spre.meters+SS.meters+Spost.meters };

  const exportTSV=()=>{ const rows=[["Gruppo","Lavoro centrale","Metri MAIN","Volume seduta"]]; const add=(g:string, b:any, t:string)=> rows.push([g,(t||"").replace(/\s+/g,' ').trim(), String(Math.round(b.main.meters)), String(Math.round(b.total))]); add("Mezzofondo",boxM,mainM); add("Velocisti",boxV,mainV); add("Salvamento",boxS,mainS); const tsv=rows.map(r=>r.join('\t')).join('\r\n'); navigator.clipboard.writeText(tsv).then(()=>alert('TSV copiato: incolla in Fogli Google')); };
  const printPDF=()=>{ setTimeout(()=>window.print(), 50); };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 font-sans">
        {/* Top bar settimana + titolo + data/ora */}
        <div className="bg-white rounded-2xl shadow p-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <button className="px-3 py-1 rounded border" onClick={()=>setWeekAnchor(addDays(weekAnchor,-7))}>{"< Settimana"}</button>
            <button className="px-3 py-1 rounded border" onClick={()=>{ const today=startOfWeekMon(new Date()); setWeekAnchor(today); setDateTime(`${fmt(new Date())}${dateTime.includes('T')?'T'+dateTime.split('T')[1]:''}`); }}>Oggi</button>
            <button className="px-3 py-1 rounded border" onClick={()=>setWeekAnchor(addDays(weekAnchor,7))}>{"Settimana >"}</button>
          </div>
          <input type="text" value={sessionTitle} onChange={(e)=>setSessionTitle(e.target.value)} placeholder="Titolo seduta" className="border rounded px-2 py-1 w-[280px] flex-1 min-w-[220px]" />
          <input type="datetime-local" value={dateTime} onChange={(e)=>setDateTime(e.target.value)} className="border rounded px-2 py-1" />
        </div>
      <div className="max-w-[1200px] mx-auto p-4 space-y-4">
        {/* Totali settimana */}
        <div className="flex items-center gap-3">
          <div className="px-3 py-2 rounded-xl border bg-white text-sm flex items-center gap-2"><span className="text-gray-500">Mezzofondo</span><span className="font-mono font-semibold">{weeklyTotals.mez.toLocaleString()} m</span></div>
          <div className="px-3 py-2 rounded-xl border bg-white text-sm flex items-center gap-2"><span className="text-gray-500">Velocisti</span><span className="font-mono font-semibold">{weeklyTotals.vel.toLocaleString()} m</span></div>
          <div className="px-3 py-2 rounded-xl border bg-white text-sm flex items-center gap-2"><span className="text-gray-500">Salvamento</span><span className="font-mono font-semibold">{weeklyTotals.sal.toLocaleString()} m</span></div>
        </div>

        {/* Card settimanali */}
        <div className="grid grid-cols-7 gap-2">
          {days.map((d)=>{ const iso=fmt(d); const s=getDaySummary(iso); const sel = iso===dateISO; return (
            <button key={iso} onClick={()=> setDateTime(`${iso}T${(dateTime.split('T')[1]||'18:00')}`)} className={`text-left rounded-xl border p-2 ${sel? 'border-blue-600 ring-2 ring-blue-200':'border-gray-200 hover:border-gray-300'}`}>
              <div className="text-xs text-gray-500">{d.toLocaleDateString(undefined,{weekday:'short'})}</div>
              <div className="font-medium">{d.getDate().toString().padStart(2,'0')}/{(d.getMonth()+1).toString().padStart(2,'0')}</div>
              <div className="mt-2 text-[11px] grid gap-1">
                <div className="flex items-center justify-between"><span className="text-gray-500">Mez:</span><span>{s.mez}</span></div>
                <div className="flex items-center justify-between"><span className="text-gray-500">Vel:</span><span>{s.vel}</span></div>
                <div className="flex items-center justify-between"><span className="text-gray-500">Sal:</span><span>{s.sal}</span></div>
              </div>
            </button>
          ); })}
        </div>

        {/* Editor seduta */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between mb-2"><h2 className="font-semibold">Editor seduta</h2><span className="text-xs text-gray-500">Usa [MAIN] per separare pre/post dal lavoro centrale</span></div>
          <textarea value={editor} onChange={(e)=>setEditor(e.target.value)} rows={10} className="w-full border rounded-2xl p-3 text-base leading-6" placeholder={`Scrivi qui la seduta...\n[MAIN] separa pre/post dal lavoro centrale.\nMoltiplicatori: 2x( ... ) oppure\n2x\n200 pull @3:00\n4x50 kick @1:00\n`}/>
          {links.length>0 && (
            <div className="mt-3 rounded-xl border p-3 bg-gray-50">
              <div className="font-medium mb-1">Link rapidi</div>
              <ul className="list-disc pl-5 text-sm">{links.map(l=> <li key={l.href}><a className="text-blue-600 hover:underline" href={l.href} target="_blank" rel="noreferrer noopener">{l.label}</a></li>)}</ul>
            </div>
          )}
        </div>

        {/* Lavoro centrale per gruppo */}
        <div className="bg-white rounded-2xl shadow p-4">
          <h2 className="font-semibold mb-3">Lavoro centrale per gruppo</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <GroupBox label="Mezzofondo" value={mez} onChange={setMez} />
            <GroupBox label="Velocisti" value={vel} onChange={setVel} />
            <GroupBox label="Salvamento" value={sal} onChange={setSal} />
          </div>
        </div>

        {/* Statistiche rapide */}
        <div className="bg-white rounded-2xl shadow p-4">
          <h2 className="font-semibold mb-3">Statistiche rapide</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <Stat title="Mezzofondo" s={boxM} />
            <Stat title="Velocisti" s={boxV} />
            <Stat title="Salvamento" s={boxS} />
          </div>
        </div>

        {/* Azioni */}
        <div className="bg-white rounded-2xl shadow p-4 flex flex-wrap items-center gap-2 no-print">
          {/* Share controls */}
          <div className="flex items-center gap-2 mr-auto">
            <span className={`text-xs px-2 py-1 rounded ${connected? 'bg-emerald-100 text-emerald-700':'bg-gray-100 text-gray-600'}`}>{connected? (readOnly? 'Connesso (RO)':'Connesso') : 'Offline'}</span>
            <button onClick={()=>{
              const ok=ensureFirebase(); if(!ok){ alert('Config Firebase mancante: inserisci le chiavi in cima al file.'); return; }
              const id = docId || Math.random().toString(36).slice(2);
              const ref = doc(db, 'ab_shared_lite', id);
              const payload = { sessionTitle, dateTime, weekAnchorISO: fmt(weekAnchor), editor, mez, vel, sal, updatedAt: Date.now() };
              setDoc(ref, payload, { merge:true }).then(()=>{
                const url = new URL(window.location.href); url.searchParams.set('doc', id); url.searchParams.delete('ro');
                navigator.clipboard.writeText(url.toString()); alert('Link (modifica) copiato negli appunti!');
                window.history.replaceState({}, '', url.toString());
              }).catch(()=> alert('Errore nel creare il link.'));
            }} className="px-3 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-700">Crea link (modifica)</button>
            <button onClick={()=>{
              const ok=ensureFirebase(); if(!ok){ alert('Config Firebase mancante: inserisci le chiavi in cima al file.'); return; }
              const id = docId || Math.random().toString(36).slice(2);
              const ref = doc(db, 'ab_shared_lite', id);
              const payload = { sessionTitle, dateTime, weekAnchorISO: fmt(weekAnchor), editor, mez, vel, sal, updatedAt: Date.now() };
              setDoc(ref, payload, { merge:true }).then(()=>{
                const url = new URL(window.location.href); url.searchParams.set('doc', id); url.searchParams.set('ro','1');
                navigator.clipboard.writeText(url.toString()); alert('Link (sola lettura) copiato negli appunti!');
                window.history.replaceState({}, '', url.toString());
              }).catch(()=> alert('Errore nel creare il link.'));
            }} className="px-3 py-2 rounded bg-gray-800 text-white hover:bg-gray-900">Crea link (RO)</button>
          </div>

          <button onClick={exportTSV} className="px-3 py-2 rounded bg-amber-600 text-white hover:bg-amber-700">Copia TSV</button>
          <button onClick={printPDF} className="px-3 py-2 rounded bg-fuchsia-600 text-white hover:bg-fuchsia-700">Esporta PDF</button>
        </div>
      </div>
    </div>
  );
}
