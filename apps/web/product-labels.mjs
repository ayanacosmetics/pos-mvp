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

export function normalizeCode128Text(value){
  return String(value??'').trim().replace(/[^\x20-\x7e]/g,'?').slice(0,80);
}

export function code128Values(value){
  const text=normalizeCode128Text(value);
  if(!text)throw new Error('Kode barcode tidak boleh kosong.');
  const data=[...text].map((character)=>character.charCodeAt(0)-32);
  const checksum=(104+data.reduce((sum,item,index)=>sum+item*(index+1),0))%103;
  return [104,...data,checksum,106];
}

export function code128Modules(value){
  return code128Values(value).map((item)=>CODE128_PATTERNS[item]).join('');
}

export function code128Svg(value,{height=46}={}){
  const text=normalizeCode128Text(value),modules=code128Modules(text);
  const label=text.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  let x=10,bars='';
  for(const pattern of modules){
    for(let index=0;index<pattern.length;index+=1){
      const width=Number(pattern[index]);
      if(index%2===0)bars+=`<rect x="${x}" y="0" width="${width}" height="${height}"/>`;
      x+=width;
    }
  }
  return `<svg class="product-label-barcode" viewBox="0 0 ${x+10} ${height}" role="img" aria-label="Barcode ${label}" preserveAspectRatio="none">${bars}</svg>`;
}

export function labelSize(width=33,height=15){
  const safe=(value,fallback)=>Math.min(200,Math.max(10,Number(value)||fallback));
  return {width:safe(width,33),height:safe(height,15)};
}
