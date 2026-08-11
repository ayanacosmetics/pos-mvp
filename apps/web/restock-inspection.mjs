function number(value) {
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:0;
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
