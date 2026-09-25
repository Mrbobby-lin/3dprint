-- 状态变更记录里的 note 有两个来源，可见性不同：
--   1. 常规推进时填的说明（"已上机打印"）—— 是给客户看的进度描述，客户时间线要显示
--   2. 越级变更时必填的原因（"客户投诉，破例跳过排队"）—— 是内部审计记录，不能给客户看
--
-- 字段本身分不出这两种，所以显式标记。默认 0（客户可见），保持既有记录的行为不变。
ALTER TABLE order_status_history ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
