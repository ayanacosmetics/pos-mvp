const CODE128_PATTERNS=[
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212',
  '112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321',
  '112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212',
  '124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'
];
const EAN_L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const EAN_G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const EAN_R=['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const EAN13_PARITY=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

export function normalizeCode128Text(value){
  return String(value??'').trim().replace(/[^\x20-\x7e]/g,'?').slice(0,80);
}

export function code128Values(value){
  return code128ValuesFor(value,'AUTO');
}

export function code128ValuesFor(value,mode='AUTO'){
  const text=normalizeCode128Text(value);
  if(!text)throw new Error('Kode barcode tidak boleh kosong.');
  const numeric=mode==='C'||(mode==='AUTO'&&/^\d+$/.test(text)&&text.length%2===0);
  if(mode==='C'&&(!/^\d+$/.test(text)||text.length%2!==0))throw new Error('Code 128C memerlukan jumlah digit genap.');
  const start=numeric?105:104;
  const data=numeric
    ?text.match(/\d{2}/g).map(Number)
    :[...text].map((character)=>character.charCodeAt(0)-32);
  const checksum=(start+data.reduce((sum,item,index)=>sum+item*(index+1),0))%103;
  return [start,...data,checksum,106];
}

export function code128Modules(value){
  return code128ModulesFor(value,'AUTO');
}

export function code128ModulesFor(value,mode='AUTO'){
  return code128ValuesFor(value,mode).map((item)=>CODE128_PATTERNS[item]).join('');
}

export function code128Svg(value,{height=46,mode='AUTO'}={}){
  const text=normalizeCode128Text(value),modules=code128ModulesFor(text,mode);
  const label=text.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  let x=10,bars='';
  for(let index=0;index<modules.length;index+=1){
    const width=Number(modules[index]);
    if(index%2===0)bars+=`<rect x="${x}" y="0" width="${width}" height="${height}"/>`;
    x+=width;
  }
  return `<svg class="product-label-barcode" viewBox="0 0 ${x+10} ${height}" role="img" aria-label="Barcode ${label}" preserveAspectRatio="none" shape-rendering="crispEdges">${bars}</svg>`;
}

export function eanChecksum(value){
  const digits=String(value).replace(/\D/g,'').split('').map(Number);
  const sum=digits.reduce((total,digit,index)=>total+digit*((digits.length-index)%2===0?1:3),0);
  return (10-(sum%10))%10;
}

export function validEan(value,length){
  const text=String(value??'').trim();
  if(!new RegExp(`^\\d{${length}}$`).test(text))return false;
  return eanChecksum(text.slice(0,-1))===Number(text.at(-1));
}

export function eanBits(value,type){
  const text=String(value??'').trim();
  if(type==='EAN13'){
    if(!validEan(text,13))throw new Error('Kode bukan EAN-13 yang valid.');
    const parity=EAN13_PARITY[Number(text[0])];
    const left=[...text.slice(1,7)].map((digit,index)=>(parity[index]==='L'?EAN_L:EAN_G)[Number(digit)]).join('');
    const right=[...text.slice(7)].map((digit)=>EAN_R[Number(digit)]).join('');
    return `101${left}01010${right}101`;
  }
  if(type==='EAN8'){
    if(!validEan(text,8))throw new Error('Kode bukan EAN-8 yang valid.');
    return `101${[...text.slice(0,4)].map((digit)=>EAN_L[Number(digit)]).join('')}01010${[...text.slice(4)].map((digit)=>EAN_R[Number(digit)]).join('')}101`;
  }
  throw new Error('Jenis EAN tidak valid.');
}

export function barcodeTypeFor(value,type='AUTO'){
  const text=String(value??'').trim();
  if(type!=='AUTO')return type;
  if(validEan(text,13))return'EAN13';
  if(validEan(text,8))return'EAN8';
  return'CODE128';
}

export function barcodeSvg(value,{height=46,type='AUTO'}={}){
  const resolved=barcodeTypeFor(value,type);
  if(resolved==='CODE128')return code128Svg(value,{height,mode:'AUTO'});
  if(resolved==='CODE128B')return code128Svg(value,{height,mode:'B'});
  if(resolved==='CODE128C')return code128Svg(value,{height,mode:'C'});
  const bits=eanBits(value,resolved),quiet=9,label=normalizeCode128Text(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const bars=[...bits].map((bit,index)=>bit==='1'?`<rect x="${quiet+index}" y="0" width="1" height="${height}"/>`:'').join('');
  return `<svg class="product-label-barcode" viewBox="0 0 ${bits.length+quiet*2} ${height}" role="img" aria-label="${resolved} ${label}" preserveAspectRatio="none" shape-rendering="crispEdges">${bars}</svg>`;
}

export function barcodeModuleCount(value,type='AUTO'){
  const resolved=barcodeTypeFor(value,type);
  if(resolved==='EAN13'||resolved==='EAN8')return eanBits(value,resolved).length+18;
  const mode=resolved==='CODE128B'?'B':resolved==='CODE128C'?'C':'AUTO';
  return [...code128ModulesFor(value,mode)].reduce((total,width)=>total+Number(width),0)+20;
}

export function labelSize(width=33,height=15){
  const safe=(value,fallback)=>Math.min(200,Math.max(10,Number(value)||fallback));
  return {width:safe(width,33),height:safe(height,15)};
}
