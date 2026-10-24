ALTER TABLE social_moderation_events DROP CONSTRAINT social_moderation_events_action_check;
ALTER TABLE social_moderation_events ADD CONSTRAINT social_moderation_events_action_check
 CHECK (action IN ('hide','unhide','suspend','unsuspend','remove_avatar','resolve_report')) NOT VALID;
ALTER TABLE social_moderation_events VALIDATE CONSTRAINT social_moderation_events_action_check;
