export enum BalanceActionType {
  PAYOUT = "PAYOUT",
  CORRECTION = "CORRECTION",
  TICKET_SALE = "TICKET_SALE"
}

export interface CreateBalanceActionRequest {
  type: BalanceActionType;
  amount: number;
  reference?: string;
}

export interface BalanceWithActions {
  id: number;
  userID: number;
  balance: number;
  actions: BalanceAction[];
  created: Date;
  updated: Date;
}

export interface BalanceAction {
  id: number;
  balanceID: number;
  type: BalanceActionType;
  amount: number;
  reference?: string;
  created: Date;
  updated: Date;
}

export interface BalanceHistoryRequest {
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}
