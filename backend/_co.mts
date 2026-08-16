import fs from 'node:fs';
import { toRupees } from './lib/nubraData.js';

const raw = JSON.parse(fs.readFileSync('./cache/refdata/MCX_2026-08-07.json','utf8')) as Record<string,unknown>[];

// parseRows
interface Row { asset:string; name:string; type:string; assetType:string; optionType?:string; strike?:number; expiry?:string; lot?:number }
const rows: Row[] = [];
for (const r of raw) {
  const asset = String(r.asset || r.underlying || '').trim().toUpperCase();
  if (!asset) continue;
  const aliases=[...new Set([r.stock_name,r.symbol,r.trading_symbol,r.tradingsymbol,r.display_name,r.displayName,r.zanskar_name,r.nubra_name].map(v=>String(v||'').trim().toUpperCase()).filter(Boolean))];
  if (!aliases.length) continue;
  const dtype=String(r.derivative_type||r.type||'').toUpperCase();
  const assetType=String(r.asset_type||r.assetType||'').toUpperCase();
  const optionType=String(r.option_type||r.ot||r.side||'').toUpperCase();
  const strike=toRupees(r.strike_price??r.strike);
  const expiry=String(r.expiry||'').replace(/-/g,'');
  const lot=Number(r.lot_size||r.lot||0);
  rows.push({asset,name:aliases[0],type:dtype,assetType,
    optionType: optionType==='CE'?'CE':optionType==='PE'?'PE':undefined,
    strike: strike!=null&&strike>0?strike:undefined,
    expiry: expiry.length===8?expiry:undefined, lot: lot>0?lot:undefined});
}

// buildEligible
const el = new Map<string,{expiries:string[];lot:number;kind:string}>();
for (const row of rows) {
  if (row.type!=='OPT') continue;
  if (!row.expiry) continue;
  const at=row.assetType;
  const kind = at.startsWith('COM')?'COMMODITY':at.startsWith('INDEX')?'INDEX':at.startsWith('STOCK')?'STOCK':'STOCK';
  const ex=el.get(row.asset);
  if(ex){ if(!ex.expiries.includes(row.expiry)) ex.expiries.push(row.expiry); if(!ex.lot&&row.lot) ex.lot=row.lot; }
  else el.set(row.asset,{expiries:[row.expiry],lot:row.lot??0,kind});
}
const co = el.get('CRUDEOIL');
console.log('CRUDEOIL eligible:', JSON.stringify(co));
console.log('');
// rollingOptionRows filter
const out = rows.filter(r=>r.asset==='CRUDEOIL' && r.type==='OPT' && (r.optionType==='CE'||r.optionType==='PE') && r.expiry && r.name && r.strike!=null && Number.isFinite(r.strike));
console.log('rollingOptionRows kept:', out.length);
console.log('expiries:', [...new Set(out.map(r=>r.expiry))].sort().join(' '));
