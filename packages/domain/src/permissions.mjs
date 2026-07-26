export const PERMISSIONS = Object.freeze({
  POS_SELL: 'pos.sell',
  VIEW_COST: 'purchasing.view_cost',
  RECEIVE_PURCHASE: 'purchasing.receive',
  MANAGE_INVENTORY: 'inventory.manage',
  PROCESS_RETURN: 'sales.return',
  MANAGE_PRODUCTS: 'catalog.manage',
  MANAGE_PROMOTIONS: 'promotion.manage',
  VIEW_REPORTS: 'report.view',
  VIEW_AUDIT: 'audit.view',
  MANAGE_USERS: 'identity.manage'
});

export const ROLE_PERMISSIONS = Object.freeze({
  OWNER: Object.values(PERMISSIONS),
  CASHIER: [PERMISSIONS.POS_SELL],
  PURCHASING: [PERMISSIONS.VIEW_COST, PERMISSIONS.RECEIVE_PURCHASE],
  ADMIN: [PERMISSIONS.POS_SELL, PERMISSIONS.VIEW_COST, PERMISSIONS.RECEIVE_PURCHASE, PERMISSIONS.PROCESS_RETURN, PERMISSIONS.MANAGE_INVENTORY, PERMISSIONS.MANAGE_PRODUCTS, PERMISSIONS.MANAGE_PROMOTIONS, PERMISSIONS.VIEW_REPORTS, PERMISSIONS.VIEW_AUDIT]
});

export function permissionsFor(role) {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

export function can(session, permission) {
  return Boolean(session?.permissions?.includes(permission));
}
