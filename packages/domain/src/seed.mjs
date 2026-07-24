export const outlets = [
  { id: 'outlet-utama', name: 'Toko Utama', code: 'UTM' },
  { id: 'gudang-utama', name: 'Gudang Utama', code: 'GDG' }
];

export const customerGroups = [
  { id: 'retail', name: 'Eceran' },
  { id: 'wholesale', name: 'Grosir' }
];

export const products = [
  {
    id: 'lip-tint-a', sku: 'KOS-LTA-01', name: 'Lip Tint Velvet A', category: 'Lip Tint', brand: 'Veluna', stockBase: 84,
    units: [
      { id: 'lip-tint-a-pcs', name: 'pcs', factor: 1, barcode: '8991000000011' },
      { id: 'lip-tint-a-lusin', name: 'lusin', factor: 12, barcode: '8991000000012' }
    ],
    priceRules: [
      { id: 'price-lta-retail', customerGroupId: 'retail', minBaseQty: 1, unitPriceBase: 45000 },
      { id: 'price-lta-tier-12', customerGroupId: null, minBaseQty: 12, unitPriceBase: 40500 },
      { id: 'price-lta-wholesale', customerGroupId: 'wholesale', minBaseQty: 1, unitPriceBase: 42000 }
    ]
  },
  {
    id: 'bedak-b', sku: 'KOS-BDK-02', name: 'Bedak Compact B', category: 'Bedak', brand: 'Cantika', stockBase: 42,
    units: [
      { id: 'bedak-b-pcs', name: 'pcs', factor: 1, barcode: '8991000000021' },
      { id: 'bedak-b-karton', name: 'karton', factor: 24, barcode: '8991000000024' }
    ],
    priceRules: [
      { id: 'price-bdk-retail', customerGroupId: 'retail', minBaseQty: 1, unitPriceBase: 38000 },
      { id: 'price-bdk-tier-24', customerGroupId: null, minBaseQty: 24, unitPriceBase: 34500 }
    ]
  },
  {
    id: 'sabun-cair', sku: 'CMP-SBN-03', name: 'Sabun Cair Fresh', category: 'Kebutuhan Rumah', brand: 'Bersihku', stockBase: 160,
    units: [
      { id: 'sabun-cair-pcs', name: 'pcs', factor: 1, barcode: '8991000000031' },
      { id: 'sabun-cair-karton', name: 'karton', factor: 12, barcode: '8991000000032' }
    ],
    priceRules: [
      { id: 'price-sbn-retail', customerGroupId: 'retail', minBaseQty: 1, unitPriceBase: 12500 },
      { id: 'price-sbn-tier-12', customerGroupId: null, minBaseQty: 12, unitPriceBase: 11250 }
    ]
  },
  {
    id: 'shampoo-c', sku: 'CMP-SHP-04', name: 'Shampoo Herbal C', category: 'Perawatan Rambut', brand: 'Naturia', stockBase: 66,
    units: [{ id: 'shampoo-c-pcs', name: 'pcs', factor: 1, barcode: '8991000000041' }],
    priceRules: [{ id: 'price-shp-retail', customerGroupId: 'retail', minBaseQty: 1, unitPriceBase: 28500 }]
  }
];

export const promotionVersions = [
  {
    id: 'promo-lip-july-v3', promotionId: 'promo-lip-july', version: 3, code: 'GROSIR5', name: 'Grosir Lip Tint', status: 'PUBLISHED',
    startsAt: '2026-07-01T00:00:00+08:00', endsAt: '2026-07-31T23:59:59+08:00', priority: 50,
    stackable: false, condition: { category: 'Lip Tint', minBaseQty: 12 }, reward: { type: 'PERCENT_ITEM', value: 5, maxDiscount: 100000 }
  }
];

export const costHistory = {
  'lip-tint-a': [
    { supplierId: 'sup-cantika', supplier: 'PT Cantik Abadi', batch: 'LTA-2605', occurredAt: '2026-05-12', costPerBase: 29500 },
    { supplierId: 'sup-cantika', supplier: 'PT Cantik Abadi', batch: 'LTA-2606', occurredAt: '2026-06-18', costPerBase: 30000 }
  ],
  'bedak-b': [
    { supplierId: 'sup-cantika', supplier: 'PT Cantik Abadi', batch: 'BDK-2605', occurredAt: '2026-05-21', costPerBase: 17000 }
  ]
};

export const demoUsers = [
  { id: 'user-owner', email: 'owner@demo.local', password: 'owner123', displayName: 'Ibu Pemilik', role: 'OWNER', outletIds: ['outlet-utama', 'gudang-utama'] },
  { id: 'user-cashier', email: 'kasir@demo.local', password: 'kasir123', displayName: 'Rina Kasir', role: 'CASHIER', outletIds: ['outlet-utama'] },
  { id: 'user-purchasing', email: 'beli@demo.local', password: 'beli123', displayName: 'Budi Pembelian', role: 'PURCHASING', outletIds: ['outlet-utama', 'gudang-utama'] }
];
