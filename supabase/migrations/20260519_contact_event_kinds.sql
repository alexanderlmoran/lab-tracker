-- Add Nadia-style contact-attempt events to the lab_event_kind enum.
-- "contact_attempted" is logged each time staff try to reach a patient and
-- don't connect (no answer, VM, wrong number, etc). "contact_reached"
-- clears the open-attempt counter on the card without deleting history.

alter type lab_event_kind add value if not exists 'contact_attempted';
alter type lab_event_kind add value if not exists 'contact_reached';
