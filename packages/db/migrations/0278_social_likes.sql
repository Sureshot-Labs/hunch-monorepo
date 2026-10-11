-- Likes are lightweight interactions, not financial or moderation history.
-- AI targets identify the exact published revision, never the thread root.
create table social_likes (
  user_id uuid not null references users(id) on delete cascade,
  thesis_id uuid references user_theses(id) on delete cascade,
  ai_note_id uuid references ai_notes(id) on delete cascade,
  comment_id uuid references social_comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint social_likes_exact_target check (num_nonnulls(thesis_id,ai_note_id,comment_id)=1)
);
create unique index social_likes_thesis_user on social_likes(thesis_id,user_id) where thesis_id is not null;
create unique index social_likes_hunch_user on social_likes(ai_note_id,user_id) where ai_note_id is not null;
create unique index social_likes_comment_user on social_likes(comment_id,user_id) where comment_id is not null;
create index social_likes_user on social_likes(user_id);
