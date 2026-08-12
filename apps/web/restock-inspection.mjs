function number(value) {
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:0;
}

export function reconcilePurchaseReceiptDraft(draft,currentOrder) {
  if(!draft?.activePurchaseOrder?.id||!currentOrder?.id||draft.activePurchaseOrder.id!==currentOrder.id){
    return {draft,changed:false,removedCount:0,resetCount:0,addedCount:0};
  }
  const orderLines=new Map(
    (currentOrder.items??[]).map((item)=>[item.product_id,item])
  );
  const outstanding=new Map(
    (currentOrder.items??[])
      .filter((item)=>number(item.remaining_qty)>0)
      .map((item)=>[item.product_id,item])
  );
  const explicitPoProducts=new Set(
    (draft.lines??[])
      .filter((line)=>line.poLine===true&&line.productId)
      .map((line)=>line.productId)
  );
  const seen=new Set(),lines=[];
  let removedCount=0,resetCount=0;
  for(const original of draft.lines??[]){
    const saved={...original};
    if(saved.poLine!==true){
      const originalOrderLine=orderLines.get(saved.productId);
      if(!originalOrderLine){lines.push(saved);continue;}
      // Older drafts could save a PO product again as a supplemental line.
      // A fully received product must disappear, while an outstanding product
      // is represented by exactly one canonical PO line.
      if(number(originalOrderLine.remaining_qty)<=0||explicitPoProducts.has(saved.productId)||seen.has(saved.productId)){
        removedCount++;continue;
      }
      saved.poLine=true;
    }
    const current=outstanding.get(saved.productId);
    if(!current||seen.has(saved.productId)){removedCount++;continue;}
    seen.add(saved.productId);
    const factor=Math.max(0.000001,number(current.purchase_unit_factor??1));
    const remainingBase=number(current.remaining_qty);
    const hasQty=String(saved.qty??'').trim()!=='';
    const savedBase=number(saved.qty)*factor;
    const exceedsCurrent=hasQty&&savedBase>remainingBase+0.000001;
    if(exceedsCurrent){saved.qty='';saved.verificationMethod='';resetCount++;}
    lines.push({
      ...saved,poLine:true,
      unitId:current.purchase_unit_id??saved.unitId??'',
      unitName:current.purchase_unit_name??saved.unitName??'pcs',
      poRemainingBaseQty:String(remainingBase),
      poRemainingPurchaseQty:String(remainingBase/factor)
    });
  }
  let addedCount=0;
  for(const current of outstanding.values()){
    if(seen.has(current.product_id))continue;
    const factor=Math.max(0.000001,number(current.purchase_unit_factor??1));
    lines.push({
      productId:current.product_id,productKey:null,poLine:true,
      poRemainingPurchaseQty:String(number(current.remaining_qty)/factor),
      poRemainingBaseQty:String(number(current.remaining_qty)),qty:'',verificationMethod:'',
      unitId:current.purchase_unit_id??'',unitName:current.purchase_unit_name??'pcs',
      cost:String(current.purchase_unit_cost??number(current.unit_cost)*factor),
      batch:'',expiry:'',proposedPrices:[]
    });
    addedCount++;
  }
  const changed=removedCount>0||resetCount>0||addedCount>0
    ||number(draft.activePurchaseOrder.outstanding_qty)!==number(currentOrder.outstanding_qty);
  return {
    draft:{...draft,activePurchaseOrder:structuredClone(currentOrder),lines,updatedAt:new Date().toISOString()},
    changed,removedCount,resetCount,addedCount
  };
}

export function buildPurchaseReceiptInspection({
  purchaseOrderId=null,documentNo='',orderItems=[],lines=[],inspectedAt=new Date().toISOString()
}={}) {
  const remainingByProduct=new Map(
    orderItems
      .filter((item)=>number(item.remaining_qty)>0)
      .map((item)=>[item.product_id,number(item.remaining_qty)])
  );
  const normalizedLines=lines.map((line)=>{
    const factor=Math.max(0.000001,number(line.purchaseUnitFactor??line.factor??1));
    const purchaseQty=Math.max(0,number(line.purchaseQty??line.qty));
    const baseQty=Math.max(0,number(line.baseQty??purchaseQty*factor));
    const poRemainingBaseQty=remainingByProduct.get(line.productId)??Math.max(0,number(line.poRemainingBaseQty));
    return {
      productId:line.productId??null,productKey:line.productKey??null,
      productName:String(line.productName??'').trim(),poLine:line.poLine===true,
      verificationMethod:String(line.verificationMethod??'').trim(),purchaseQty,
      purchaseUnitName:String(line.purchaseUnitName??line.unitName??'pcs').trim()||'pcs',
      purchaseUnitFactor:factor,baseQty,poRemainingBaseQty
    };
  });
  const actualByProduct=new Map();
  for(const line of normalizedLines){
    if(line.productId)actualByProduct.set(line.productId,(actualByProduct.get(line.productId)??0)+line.baseQty);
  }
  const orderedRemainingBaseQty=[...remainingByProduct.values()].reduce((sum,value)=>sum+value,0);
  const notReceivedBaseQty=[...remainingByProduct.entries()].reduce(
    (sum,[productId,remaining])=>sum+Math.max(0,remaining-(actualByProduct.get(productId)??0)),0
  );
  const actualReceivedBaseQty=normalizedLines.reduce((sum,line)=>sum+line.baseQty,0);
  const excessBaseQty=normalizedLines.reduce((sum,line)=>{
    if(!line.productId||!remainingByProduct.has(line.productId))return sum+line.baseQty;
    return sum+Math.max(0,line.baseQty-remainingByProduct.get(line.productId));
  },0);
  const verifiedItemCount=normalizedLines.filter(
    (line)=>['scan','manual'].includes(line.verificationMethod)||!line.poLine
  ).length;
  return {
    version:1,purchaseOrderId,documentNo:String(documentNo??'').trim(),inspectedAt,
    summary:{
      orderedRemainingBaseQty,actualReceivedBaseQty,notReceivedBaseQty,excessBaseQty,
      itemCount:normalizedLines.length,verifiedItemCount,
      completion:notReceivedBaseQty===0?'COMPLETE':'PARTIAL'
    },
    lines:normalizedLines
  };
}

export function purchaseReceiptShortageMessage(summary={}) {
  const expected=number(summary.orderedRemainingBaseQty);
  const received=number(summary.actualReceivedBaseQty);
  const missing=number(summary.notReceivedBaseQty);
  if(!(missing>0))return '';
  return `Pemeriksaan selesai, tetapi jumlah belum penuh. Sisa PO ${expected.toLocaleString('id-ID')} pcs; akan diterima ${received.toLocaleString('id-ID')} pcs; belum datang ${missing.toLocaleString('id-ID')} pcs. Lanjutkan hanya jika angka ini sesuai kondisi fisik.`;
}
