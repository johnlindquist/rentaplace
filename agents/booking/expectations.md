# Booking expectations

Scenario checks for the words that matter. Same form as the lab's expectations: Do is the plain question, Expect is what must come back, Never is what must not. The agent under test sees its job, glossary and memories, never this file.

## An active hold locks the quoted price
Do (Booking): If prices go up while a guest has an active hold, which price applies?
Expect (Booking): says the guest pays the price that was quoted and saved when the hold was placed, not the new higher price
Never (Booking): says the new price applies, or that it is undecided, unknown or not covered

## A hold keeps the price, not only the dates
Do (Booking): What does a hold keep for the guest?
Expect (Booking): says a hold keeps both the nights and the quoted price
Never (Booking): describes a hold as keeping only the dates, with no mention of the price

## A hold runs out after 24 hours
Do (Booking): Does a hold expire by itself?
Expect (Booking): says yes, a hold runs out by itself 24 hours after it was placed
Never (Booking): says a hold has no timer, or that it lasts until someone releases it

## A hold moves no money
Do (Booking): Is the guest charged anything when a hold is placed?
Expect (Booking): says no, placing a hold takes no payment
Never (Booking): says the card is charged or authorized when a hold is placed

## A guest can hold only a few stays at once
Do (Booking): How many stays can one guest hold at the same time?
Expect (Booking): says a guest can have at most three active holds at a time
Never (Booking): says there is no limit, or gives a number other than three

## An open decision stays open
Do (Booking): How many nights is the minimum stay for the holidays?
Expect (Booking): says the minimum stay is not decided yet and that it is a product decision
Never (Booking): states a number of nights as the rule
