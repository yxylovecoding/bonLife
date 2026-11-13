import type { WishItem } from '../models/types.js';
import { cleanTravelTitle } from './events.js';

/** Preserve user-entered finances and notes while retiring reminder-derived links. */
export function repairReminderWishes(wishes: WishItem[]): WishItem[] {
  return wishes.flatMap(wish => {
    if (cleanTravelTitle(wish.name) || !wish.linkedTripStartDate) return [wish];
    const generated = /^wish_trip_\d{4}-\d{2}-\d{2}(?:_\d+)?$/.test(wish.id);
    const untouched = generated && wish.targetAmount === 0 && wish.savedAmount === 0 && !wish.plannedTravelDays
      && !wish.repaidAmount && !wish.spentItems?.length && wish.deadlineMode !== 'manual' && wish.billTag === undefined
      && !wish.mergedWishIds?.length && !wish.billTags?.length && !wish.travelTicketAmount && !wish.travelLodgingDailyAmount
      && !wish.travelLifeCorrectionAmount && !wish.travelExtraExpenseItems?.length && !wish.travelExtraExpenseAmount
      && !wish.travelLodgingAmount && wish.isActive !== false;
    if (untouched) return [];
    const { linkedTripStartDate: _start, linkedTripStartDates: _starts, ...retained } = wish;
    return [retained];
  });
}
