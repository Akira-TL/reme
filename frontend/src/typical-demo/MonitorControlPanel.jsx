import CameraswitchRoundedIcon from "@mui/icons-material/CameraswitchRounded";
import CastRoundedIcon from "@mui/icons-material/CastRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ComputerRoundedIcon from "@mui/icons-material/ComputerRounded";
import GroupsRoundedIcon from "@mui/icons-material/GroupsRounded";
import LockOpenRoundedIcon from "@mui/icons-material/LockOpenRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import PrivacyTipRoundedIcon from "@mui/icons-material/PrivacyTipRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import UploadFileRoundedIcon from "@mui/icons-material/UploadFileRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Alert,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Tooltip,
} from "@mui/material";
import { useEffect, useRef } from "react";
import { resolvePendingFileCommandId } from "./monitorFileCommand.js";

const SOURCE_ICONS = {
  camera: VideocamRoundedIcon,
  display: ComputerRoundedIcon,
  file: UploadFileRoundedIcon,
};

const COMMAND_LABELS = {
  select_source: "切换媒体源",
  start_capture: "开始采集",
};

function sourceStatusLabel(status) {
  switch (status) {
    case "ready": return "采集中";
    case "requesting": return "等待本机授权";
    case "error": return "媒体源错误";
    case "unsupported": return "浏览器不支持";
    case "ended": return "采集已结束";
    default: return "尚未采集";
  }
}

export function MonitorControlPanel({
  surface = "debug",
  started,
  starting = false,
  onStart,
  onStop,
  media,
  room,
  pendingCommands = [],
  confirmingCommands = [],
  onConfirmCommand,
  onRejectCommand,
  onRevokeControl,
  nowMs,
}) {
  const homeSurface = surface === "home";
  const fileInputRef = useRef(null);
  const pendingFileCommandRef = useRef(null);
  const filePickerIntentRef = useRef(null);
  const cameraActive = media.source?.kind === "camera";
  const sourceValue = media.source?.id || "";
  const roomSessionId = room.roomSessionId || null;
  const sourcePickerLabel = homeSurface ? "选择相机或视频" : "选择媒体源";

  useEffect(() => {
    const commandId = pendingFileCommandRef.current;
    if (!commandId) return;
    const activeCommandId = resolvePendingFileCommandId({
      commandId,
      pendingCommands,
      roomSessionId,
      nowMs,
    });
    if (activeCommandId) return;
    pendingFileCommandRef.current = null;
    if (filePickerIntentRef.current === "remote") filePickerIntentRef.current = null;
  }, [nowMs, pendingCommands, roomSessionId]);

  function clearFilePickerIntent() {
    pendingFileCommandRef.current = null;
    filePickerIntentRef.current = null;
  }

  function chooseSource(event) {
    const sourceId = event.target.value;
    if (sourceId === "file") {
      clearFilePickerIntent();
      filePickerIntentRef.current = "local";
      if (!fileInputRef.current) {
        clearFilePickerIntent();
        return;
      }
      fileInputRef.current.click();
      return;
    }
    void media.selectSource(sourceId);
  }

  function chooseFile(event) {
    const [file] = Array.from(event.target.files || []);
    const pickerIntent = filePickerIntentRef.current;
    const referencedCommandId = pendingFileCommandRef.current;
    clearFilePickerIntent();
    event.target.value = "";
    if (!file) return;
    const pendingCommandId = pickerIntent === "remote"
      ? resolvePendingFileCommandId({
        commandId: referencedCommandId,
        pendingCommands,
        roomSessionId,
        nowMs,
      })
      : null;
    if (pendingCommandId) {
      onConfirmCommand(pendingCommandId, { file });
      return;
    }
    if (pickerIntent === "local") void media.selectFile(file);
  }

  function confirmPendingCommand(pending) {
    if (
      pending.command?.name === "select_source"
      && pending.command.source_id === "file"
    ) {
      pendingFileCommandRef.current = pending.command_id;
      filePickerIntentRef.current = "remote";
      if (!fileInputRef.current) {
        clearFilePickerIntent();
        return;
      }
      fileInputRef.current.click();
      return;
    }
    onConfirmCommand(pending.command_id);
  }

  function rejectPendingCommand(commandId) {
    if (pendingFileCommandRef.current === commandId) clearFilePickerIntent();
    onRejectCommand(commandId);
  }

  return (
    <section
      className={`monitor-control-panel ${homeSurface ? "is-home-control" : ""} ${homeSurface && !started ? "is-idle" : ""}`}
      aria-label={homeSurface ? "家中数据采集与本机媒体源" : "公开演示房间与媒体源"}
    >
      <Alert
        severity={homeSurface ? "info" : "warning"}
        icon={homeSurface
          ? <PrivacyTipRoundedIcon fontSize="inherit" />
          : <WarningAmberRoundedIcon fontSize="inherit" />}
        className="public-room-warning"
      >
        <strong>{homeSurface ? "公开演示 · 无账号验证" : "公开演示房间"}</strong>
        <span>{homeSurface
          ? "启动只请求本机相机；麦克风仅在问询窗口按需请求并录制，问询语音可按需送 MiMo；跌倒确认等事件可按需选定单帧或短片送 MiMo（非连续上传）；事件期原画仅在当前授权窗口对全部在线 Viewer 开放。"
          : "无身份认证 · 事件期原画会发给全部在线 Viewer · 不代表生产隐私方案"}</span>
      </Alert>

      <div className="monitor-control-grid">
        <div className="monitor-start-block">
          <span className={`monitor-room-mark ${started ? "is-live" : ""}`}>
            {started ? <CastRoundedIcon /> : <LockOpenRoundedIcon />}
          </span>
          <div>
            <small>{homeSurface ? "当前通道 · 本机视频" : "MONITOR PRODUCER"}</small>
            <strong>{started
              ? homeSurface ? "视频通道采集中" : "演示控制端在线"
              : homeSurface ? "开启本机视频采集" : "准备进入固定公开房间"}</strong>
            <p>{started
              ? homeSurface ? "视频采集、姿态感知和事件同步都以当前会话为准" : `房间会话 ${room.roomSessionId || "正在建立"}`
              : homeSurface ? "点击后先请求本机相机权限；Relay 或后端离线时会明确降级，不阻断本机采集" : "点击后先请求本机媒体权限；producer 租约会并行建立"}</p>
          </div>
          {started ? (
            <Button color="inherit" variant="outlined" startIcon={<StopRoundedIcon />} onClick={onStop}>
              {homeSurface ? "停止视频采集" : "停止演示"}
            </Button>
          ) : (
            <Button
              className={homeSurface ? "home-primary-action" : undefined}
              color={homeSurface ? "inherit" : "warning"}
              variant="contained"
              startIcon={homeSurface ? <VideocamRoundedIcon /> : <PlayArrowRoundedIcon />}
              disabled={starting}
              onClick={onStart}
            >
              {starting ? homeSurface ? "正在开启…" : "正在连接…" : homeSurface ? "开启视频采集" : "开始演示"}
            </Button>
          )}
        </div>

        {(!homeSurface || started) && <div className="monitor-source-block">
          <div className="monitor-section-heading">
            <div>
              <small>本机媒体源</small>
              <strong>{sourceStatusLabel(media.sourceStatus)}</strong>
            </div>
            <Chip
              size="small"
              color={media.ready ? "success" : media.sourceError ? "error" : "default"}
              label={media.source?.remote_video === "local_only" ? "仅本地推理" : media.remoteVideoState === "available" ? "可用于事件原画" : "远程原画不可用"}
            />
          </div>
          <div className="monitor-source-actions">
            <FormControl size="small" fullWidth disabled={!started || media.sourceStatus === "requesting" || confirmingCommands.length > 0}>
              <InputLabel id="monitor-source-label">{sourcePickerLabel}</InputLabel>
              <Select
                labelId="monitor-source-label"
                value={sourceValue}
                label={sourcePickerLabel}
                onChange={chooseSource}
                renderValue={(selected) => media.availableSources.find((item) => item.id === selected)?.label || media.source?.label || sourcePickerLabel}
              >
                {media.availableSources.map((source) => {
                  const SourceIcon = SOURCE_ICONS[source.kind] || VideocamRoundedIcon;
                  return (
                    <MenuItem key={source.id} value={source.id} disabled={Boolean(source.disabled_reason)}>
                      <SourceIcon className="source-menu-icon" />
                      <span>{source.label}</span>
                      {source.disabled_reason && <small>{source.disabled_reason}</small>}
                    </MenuItem>
                  );
                })}
              </Select>
            </FormControl>
            {!homeSurface && (
              <Tooltip title={cameraActive ? "在手机上切换前后摄像头" : "当前不是摄像头源"}>
                <span>
                  <Button
                    variant="outlined"
                    startIcon={<CameraswitchRoundedIcon />}
                    disabled={!started || !cameraActive || media.sourceStatus === "requesting" || confirmingCommands.length > 0}
                    onClick={() => void media.switchCameraFacing()}
                  >
                    前后切换
                  </Button>
                </span>
              </Tooltip>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={chooseFile}
            onCancel={clearFilePickerIntent}
          />
          <p className={media.sourceError ? "is-error" : ""}>
            {media.sourceError?.message
              || media.source?.disabled_reason
              || (homeSurface
                ? media.source ? `当前：${media.source.label}` : "请选择本机相机、屏幕或视频"
                : `源 generation ${media.sourceGeneration} · 权限 ${media.permissionState}`)}
          </p>
        </div>}

        {(!homeSurface || started) && <div className="monitor-room-block">
          <div className="monitor-section-heading">
            <div><small>{homeSurface ? "公开演示连接" : "RELAY"}</small><strong>{room.connectionLabel}</strong></div>
            <Chip
              size="small"
              icon={<GroupsRoundedIcon />}
              label={homeSurface
                ? `${room.viewerCount || 0} 个 Viewer 在线`
                : `${room.viewerCount || 0}/${room.maxViewers || 5} Viewer`}
              color={room.monitorOnline ? "success" : "default"}
            />
          </div>
          <dl>
            <div>
              <dt>{homeSurface ? "Viewer 处理" : "控制权"}</dt>
              <dd className="monitor-controller-value">
                <span>{room.controllerLabel || "尚无 Viewer 接管"}</span>
                {room.controllerActive && (
                  <Button size="small" color="warning" onClick={onRevokeControl}>
                    {homeSurface ? "结束 Viewer 处理" : "收回"}
                  </Button>
                )}
              </dd>
            </div>
            {!homeSurface && <div><dt>权威状态</dt><dd>revision {room.stateRevision ?? 0}</dd></div>}
            <div><dt>事件原画</dt><dd>{room.mediaGrantLabel || "未开放"}</dd></div>
          </dl>
        </div>}
      </div>

      {!homeSurface && <div className={`monitor-confirmation-queue ${pendingCommands.length ? "has-pending" : ""}`}>
        <div>
          <small>远程命令与本机确认</small>
          <strong>{pendingCommands.length
            ? `${pendingCommands.length} 条命令等待本机操作`
            : "当前没有等待确认的权限操作"}</strong>
        </div>
        {pendingCommands.map((pending) => (
          <article key={pending.command_id}>
            <div>
              <b>{COMMAND_LABELS[pending.command?.name] || pending.command?.name}</b>
              <span>来自当前 controller · {pending.command_id}</span>
            </div>
            <Button
              size="small"
              color="success"
              variant="contained"
              startIcon={<CheckCircleRoundedIcon />}
              onClick={() => confirmPendingCommand(pending)}
            >
              本机确认
            </Button>
            <Button
              size="small"
              color="inherit"
              variant="outlined"
              startIcon={<CloseRoundedIcon />}
              onClick={() => rejectPendingCommand(pending.command_id)}
            >
              拒绝
            </Button>
          </article>
        ))}
        {confirmingCommands.map((pending) => (
          <article className="monitor-confirmation-item" key={pending.command_id}>
            <div>
              <strong>{COMMAND_LABELS[pending.command?.name] || "本机权限操作"}</strong>
              <p>系统授权或文件选择处理中；过期或换房后会释放新媒体源</p>
            </div>
            <Chip size="small" color="warning" label="本机处理中" />
          </article>
        ))}
      </div>}
    </section>
  );
}
