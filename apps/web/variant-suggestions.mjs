function cleanName(value){
  return String(value??'').normalize('NFKC').trim().replace(/([0-9])\s*(ML|GR|G|KG|PCS|PC|CM)\b/gi,'$1 $2').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
}

function normalizedTokens(value){return cleanName(value).toLocaleUpperCase('id').split(' ').filter(Boolean);}

function familyCode(name){
  const slug=normalizedTokens(name).join('-').replace(/[^A-Z0-9-]/g,'').slice(0,34)||'ETALASE';
  let hash=2166136261;
  for(const char of String(name).toLocaleLowerCase('id')){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619);}
  return `AUTO-${slug}-${(hash>>>0).toString(36).toUpperCase()}`.slice(0,50);
}

function codedVariant(value){return /^(?:NO\s*)?\d+[A-Z]?(?:\s|$)/i.test(value);}
function containsSize(value){return /\b\d+(?:\.\d+)?\s*(?:ML|GR|G|KG|PCS|PC|CM)\b/i.test(value);}

export function buildVariantSuggestions(products,{minimumPrefixTokens=3,maximumVariantTokens=4}={}){
  const source=(products??[]).filter((product)=>product?.active!==false&&!product?.familyId&&!String(product?.variantGroup??'').trim()).map((product)=>{
    const name=cleanName(product.name),tokens=normalizedTokens(name);
    return {...product,_candidateName:name,_tokens:tokens};
  }).filter((product)=>product._tokens.length>minimumPrefixTokens);
  const candidateMap=new Map();
  source.forEach((product)=>{
    const max=Math.min(maximumVariantTokens,product._tokens.length-minimumPrefixTokens);
    for(let remainder=1;remainder<=max;remainder+=1){
      const prefix=product._tokens.slice(0,-remainder),key=prefix.join(' ');
      if(!candidateMap.has(key))candidateMap.set(key,{key,prefix,members:new Map()});
      candidateMap.get(key).members.set(product.id,product);
    }
  });
  const ranked=[...candidateMap.values()].filter((candidate)=>candidate.members.size>=2).map((candidate)=>{
    const members=[...candidate.members.values()];
    const variants=members.map((product)=>product._tokens.slice(candidate.prefix.length).join(' '));
    return {...candidate,members,variants,maxRemainder:Math.max(...variants.map((value)=>value.split(' ').length))};
  }).sort((a,b)=>b.prefix.length-a.prefix.length||b.members.length-a.members.length||a.key.localeCompare(b.key,'id'));
  const assigned=new Set(),suggestions=[];
  ranked.forEach((candidate)=>{
    const members=candidate.members.filter((product)=>!assigned.has(product.id));
    if(members.length<2)return;
    const variants=members.map((product)=>product._tokens.slice(candidate.prefix.length).join(' '));
    if(new Set(variants).size!==variants.length)return;
    members.forEach((product)=>assigned.add(product.id));
    const sizeConflict=containsSize(candidate.key)&&variants.some(containsSize);
    const codedRatio=variants.filter(codedVariant).length/variants.length;
    const safe=!sizeConflict&&(variants.every(codedVariant)||codedRatio>=.75||(members.length>=3&&variants.every((value)=>value.split(' ').length<=3)));
    suggestions.push({
      id:familyCode(candidate.key),familyCode:familyCode(candidate.key),familyName:candidate.key,
      safe,products:members.map((product,index)=>({id:product.id,sku:product.sku,name:product.name,variantName:variants[index]}))
    });
  });
  return suggestions.sort((a,b)=>Number(b.safe)-Number(a.safe)||b.products.length-a.products.length||a.familyName.localeCompare(b.familyName,'id'));
}
