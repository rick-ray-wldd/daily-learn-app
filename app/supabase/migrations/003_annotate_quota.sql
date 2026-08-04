-- =============================================================================
-- Echo — 003_annotate_quota.sql
--
-- 新增 `annotate` Edge Function（逐字稿難詞標註）後，api_usage 的 kind 白名單
-- 要跟著開。002 建表時只列了 diagnose / transcribe，插入 'annotate' 會被
-- check constraint 擋下 —— 而 consume_api_quota 是 fail-closed 的，所以那會
-- 讓標註功能整個失效而不是靜靜降級。
--
-- 配額本身不在這裡設；上限由呼叫端傳 p_limit（annotate 目前 40/天/人）。
-- =============================================================================

alter table public.api_usage
  drop constraint if exists api_usage_kind_check;

alter table public.api_usage
  add constraint api_usage_kind_check
  check (kind in ('diagnose', 'transcribe', 'annotate'));
