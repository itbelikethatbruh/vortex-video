-- =====================================================================
-- Vortex Video — Supabase setup
-- Run once in the Supabase SQL editor (safe to re-run).
--
-- Then, in the dashboard:
--   1. Realtime → Settings → turn OFF "Allow public access"
--      (required so the private ringing/presence channels below are enforced).
--   2. Authentication → URL Configuration → Site URL = your Netlify URL.
--      Email confirmation: Supabase's built-in mailer only delivers to your
--      project's team members (about 2 emails/hour), so friends can't confirm.
--      Either turn OFF "Confirm email" (Authentication → Sign In / Providers →
--      Email), or connect a custom SMTP provider and keep it on.
--   3. Connect button (or Settings → API Keys) → copy the Project URL and the
--      publishable key (sb_publishable_…) or legacy anon key into SUPABASE_URL /
--      SUPABASE_ANON_KEY at the top of the app's script, or paste them into the
--      app's Settings → Accounts. Never use the secret / service_role key.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Profiles (one row per account; created automatically on sign-up)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null unique,
  display_name text not null default '',
  avatar_url   text,
  updated_at   timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_display_name_len check (char_length(display_name) between 1 and 24),
  -- avatars are small compressed images stored inline as data URLs (no Storage bucket needed)
  constraint profiles_avatar_format check (
    avatar_url is null
    or (char_length(avatar_url) <= 60000 and avatar_url ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$')
  )
);

alter table public.profiles enable row level security;

-- Earlier versions let every signed-in user read every profile. Now: yourself, plus anyone you
-- share a friendship row with (friends and pending requests either way). Friend search goes
-- through search_profiles() below, which is unaffected.
drop policy if exists "profiles: signed-in users can read" on public.profiles;
drop policy if exists "profiles: read self, friends and requests" on public.profiles;

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- start from nothing, then grant exactly what the app uses (rows are inserted by the trigger)
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (username, display_name, avatar_url, updated_at) on public.profiles to authenticated;

-- Create the profile from sign-up metadata ({ username, display_name }).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uname text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  dname text := left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 24);
  suffix text := substr(replace(new.id::text, '-', ''), 1, 6);
begin
  if uname !~ '^[a-z0-9_]{3,20}$' then
    uname := 'user_' || suffix;
  end if;
  if exists (select 1 from public.profiles p where p.username = uname) then
    uname := left(uname, 13) || '_' || suffix;
  end if;
  insert into public.profiles (id, username, display_name)
  values (new.id, uname, coalesce(nullif(dname, ''), uname));
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Username availability check for the sign-up form (callable before signing in).
create or replace function public.username_available(name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(name) ~ '^[a-z0-9_]{3,20}$'
     and not exists (select 1 from public.profiles p where p.username = lower(name));
$$;
revoke execute on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Friendships
-- ---------------------------------------------------------------------
create table if not exists public.friendships (
  id           bigint generated always as identity primary key,
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  constraint friendships_not_self check (requester_id <> addressee_id)
);
-- one row per pair, whichever direction it was sent
create unique index if not exists friendships_pair_key
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

alter table public.friendships enable row level security;

drop policy if exists "friendships: see own" on public.friendships;
create policy "friendships: see own"
  on public.friendships for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

drop policy if exists "friendships: send request" on public.friendships;
create policy "friendships: send request"
  on public.friendships for insert to authenticated
  with check (requester_id = (select auth.uid()) and status = 'pending');

drop policy if exists "friendships: accept requests sent to me" on public.friendships;
create policy "friendships: accept requests sent to me"
  on public.friendships for update to authenticated
  using (addressee_id = (select auth.uid()) and status = 'pending')
  with check (addressee_id = (select auth.uid()) and status = 'accepted');

drop policy if exists "friendships: remove own" on public.friendships;
create policy "friendships: remove own"
  on public.friendships for delete to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

-- clients can only flip status; ids are immutable after insert
revoke all on public.friendships from anon, authenticated;
grant select, delete on public.friendships to authenticated;
grant insert (requester_id, addressee_id, status) on public.friendships to authenticated;
grant update (status) on public.friendships to authenticated;

-- Friend-request rate limit: 30 requests an hour per sender, 3 a day to the same person
-- (declining deletes the request, so without this a sender could re-ask forever).
create table if not exists public.friend_request_log (
  requester_id uuid not null,
  addressee_id uuid not null,
  at           timestamptz not null default now()
);
create index if not exists friend_request_log_requester_at on public.friend_request_log (requester_id, at);
create index if not exists friend_request_log_at on public.friend_request_log (at);
alter table public.friend_request_log enable row level security;
revoke all on public.friend_request_log from anon, authenticated;

create or replace function public.friendships_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.friend_request_log where at < now() - interval '1 day';
  if (select count(*) from public.friend_request_log l
      where l.requester_id = new.requester_id and l.at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many friend requests. Try again later.' using errcode = '54000';
  end if;
  if (select count(*) from public.friend_request_log l
      where l.requester_id = new.requester_id and l.addressee_id = new.addressee_id) >= 3 then
    raise exception 'You''ve already asked this person several times today.' using errcode = '54000';
  end if;
  insert into public.friend_request_log (requester_id, addressee_id) values (new.requester_id, new.addressee_id);
  return new;
end;
$$;
revoke execute on function public.friendships_rate_limit() from public, anon, authenticated;

drop trigger if exists friendships_rate_limit on public.friendships;
create trigger friendships_rate_limit
  before insert on public.friendships
  for each row execute function public.friendships_rate_limit();

-- Am I friends with this user? (only ever answers about the caller)
create or replace function public.is_friend(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select other is not null and exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = (select auth.uid()) and f.addressee_id = other)
        or (f.addressee_id = (select auth.uid()) and f.requester_id = other))
  );
$$;
revoke execute on function public.is_friend(uuid) from public, anon;
grant execute on function public.is_friend(uuid) to authenticated;

-- Friend search: exact (confirmed) email match, or literal username prefix.
-- Never returns yourself; max 10.
create or replace function public.search_profiles(q text)
returns table (id uuid, username text, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = ''
as $$
  with term as (
    select btrim(coalesce(q, '')) as t,
           regexp_replace(lower(btrim(coalesce(q, ''))), '[^a-z0-9_]', '', 'g') as u
  )
  select p.id, p.username, p.display_name, p.avatar_url
  from public.profiles p, term
  where p.id <> (select auth.uid())
    and (
      (position('@' in term.t) > 1
        and exists (select 1 from auth.users au
                    where au.id = p.id and lower(au.email) = lower(term.t) and au.email_confirmed_at is not null))
      or (position('@' in term.t) <= 1
        and char_length(term.u) >= 2
        and left(p.username, char_length(term.u)) = term.u)   -- no LIKE: '_' is a literal here
    )
  order by p.username
  limit 10;
$$;
revoke execute on function public.search_profiles(text) from public, anon;
grant execute on function public.search_profiles(text) to authenticated;

-- Profiles you may read: your own, and people you have a friendship row with (any status).
create or replace function public.can_see_profile(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select pid = (select auth.uid()) or exists (
    select 1 from public.friendships f
    where (f.requester_id = (select auth.uid()) and f.addressee_id = pid)
       or (f.addressee_id = (select auth.uid()) and f.requester_id = pid)
  );
$$;
revoke execute on function public.can_see_profile(uuid) from public, anon;
grant execute on function public.can_see_profile(uuid) to authenticated;

create policy "profiles: read self, friends and requests"
  on public.profiles for select to authenticated
  using (public.can_see_profile(id));

-- Live friend-request updates (the app subscribes with per-user filters)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships'
  ) then
    alter publication supabase_realtime add table public.friendships;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Ringing + presence over private Realtime channels
--    vortex:inbox:<user_id>     incoming rings — only the owner listens; nobody may post
--                               directly: rings go through vortex_signal(), which checks
--                               friendship, rate-limits, and stamps the real sender
--    vortex:presence:<user_id>  online / in-call — only the owner publishes, friends watch
-- ---------------------------------------------------------------------
create or replace function public.vortex_topic_user(topic text)
returns uuid
language plpgsql
immutable
as $$
begin
  return split_part(topic, ':', 3)::uuid;
exception when others then
  return null;
end;
$$;
revoke execute on function public.vortex_topic_user(text) from public, anon;
grant execute on function public.vortex_topic_user(text) to authenticated;

create table if not exists public.vortex_signal_log (
  sender uuid not null,
  at     timestamptz not null default now()
);
create index if not exists vortex_signal_log_sender_at on public.vortex_signal_log (sender, at);
create index if not exists vortex_signal_log_at on public.vortex_signal_log (at);
alter table public.vortex_signal_log enable row level security;
revoke all on public.vortex_signal_log from anon, authenticated;

create or replace function public.vortex_signal(target uuid, kind text, body jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if kind is null or kind not in ('ring', 'ring-cancel', 'ring-reply') then
    raise exception 'Unknown signal.' using errcode = '22023';
  end if;
  if body is null or jsonb_typeof(body) <> 'object' or octet_length(body::text) > 2000 then
    raise exception 'Bad payload.' using errcode = '22023';
  end if;
  if target is null or target = me or not public.is_friend(target) then
    raise exception 'You can only ring friends.' using errcode = '42501';
  end if;
  delete from public.vortex_signal_log where at < now() - interval '10 minutes';
  if (select count(*) from public.vortex_signal_log l
      where l.sender = me and l.at > now() - interval '1 minute') >= 30 then
    raise exception 'Too many calls. Wait a minute.' using errcode = '54000';
  end if;
  insert into public.vortex_signal_log (sender) values (me);
  perform realtime.send(
    payload => (body - 'from') || jsonb_build_object('from', me::text),
    event   => kind,
    topic   => 'vortex:inbox:' || target::text,
    private => true
  );
end;
$$;
revoke execute on function public.vortex_signal(uuid, text, jsonb) from public, anon;
grant execute on function public.vortex_signal(uuid, text, jsonb) to authenticated;

drop policy if exists "vortex: owner listens to own inbox" on realtime.messages;
create policy "vortex: owner listens to own inbox"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and (select realtime.topic()) = 'vortex:inbox:' || (select auth.uid())::text
  );

-- earlier versions let friends broadcast straight into an inbox; that allowed a forged sender
drop policy if exists "vortex: friends can ring" on realtime.messages;

drop policy if exists "vortex: friends watch presence" on realtime.messages;
create policy "vortex: friends watch presence"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and (select realtime.topic()) like 'vortex:presence:%'
    and (
      public.vortex_topic_user((select realtime.topic())) = (select auth.uid())
      or public.is_friend(public.vortex_topic_user((select realtime.topic())))
    )
  );

drop policy if exists "vortex: publish own presence" on realtime.messages;
create policy "vortex: publish own presence"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'vortex:presence:' || (select auth.uid())::text
  );
