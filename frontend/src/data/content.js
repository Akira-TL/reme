import dashboardImage from "../assets/dashboard.png";
import cookingImage from "../assets/home-cooking.png";
import emergencyImage from "../assets/home-emergency.png";
import normalImage from "../assets/home-normal.png";
import privacyImage from "../assets/home-privacy.png";
import riskImage from "../assets/home-risk.png";
import settingsImage from "../assets/settings.png";

export const APP_IMAGES = {
  dashboard: dashboardImage,
  emergency: emergencyImage,
  settings: settingsImage,
};

export const SCENES = {
  normal: {
    name: "客厅守护",
    detail: "真实摄像头实时转为 17 节点火柴人",
    icon: "home",
    image: normalImage,
    camera: true,
  },
  cooking: {
    name: "做饭片段",
    detail: "正常生活画面，经本人授权后可分享",
    icon: "cooking",
    image: cookingImage,
    camera: false,
  },
  privacy: {
    name: "洗澡隐私",
    detail: "敏感场景自动隐藏真人，只显示火柴人",
    icon: "privacy",
    image: privacyImage,
    camera: false,
  },
  risk: {
    name: "异常姿态",
    detail: "低位停留触发中风险与子女紧急提醒",
    icon: "risk",
    image: riskImage,
    camera: false,
  },
};

export const DASHBOARD_DETAILS = {
  summary: {
    title: "本周陪伴摘要",
    eyebrow: "MIMO SUMMARY",
    body: "本周外婆作息整体规律，完成 5 次自然对话、记录 3 个已授权生活片段。情绪较上周更积极，周六与孙女约好下周一起做饭。",
  },
  cooking: {
    title: "做饭 · 番茄炒蛋",
    eyebrow: "AUTHORIZED MOMENT",
    body: "12:10 检测到做饭场景。MiMo 已向外婆询问分享意愿，并在获得授权后，仅保存成品、关键步骤和语音讲解摘要。",
  },
  dialogue: {
    title: "聊起年轻时",
    eyebrow: "CONVERSATION",
    body: "“那时候很忙，但很充实。”外婆回忆年轻时在学校教书的日子。系统只向家人展示经授权的语义摘要，不上传原始音视频。",
  },
  emotion: {
    title: "情绪变化",
    eyebrow: "WELLBEING",
    body: "本周积极表达较上周增加 12%。周三和周日心情较好；与家人通话后的积极表达持续时间更长。该结论仅作关怀参考，不是医疗诊断。",
  },
  journey: {
    title: "心路历程",
    eyebrow: "MEMORY PATH",
    body: "周二想起年轻时在学校教书的日子；周六主动和孙女约好下周一起做饭。Reme 把零散的生活瞬间整理成可回看的家庭记忆。",
  },
  range: {
    title: "统计周期",
    eyebrow: "DATE RANGE",
    body: "当前显示最近 7 天。比赛演示版也可切换最近 30 天与自定义日期，所有摘要遵循长辈授权范围。",
  },
};

export const SETTINGS_DETAILS = {
  family: ["外婆家", "当前连接客厅摄像头、厨房摄像头和 Reme Pin，共 3 台设备。"],
  local: ["本地处理", "摄像头原画仅在设备本地参与姿态识别；默认只向子女端发送骨骼节点、状态与事件摘要。"],
  sharing: ["分享授权", "生活片段在发送给家人前需要外婆确认；洗澡、换衣等敏感场景永不发送原画。"],
  risk: ["风险提醒", "异常姿态持续 20 秒后触发中风险；MiMo 先询问，未响应时立即通知子女与紧急联系人。"],
  pin: ["Reme Pin", "设备在线，电量 86%。可用于确认分享、主动报平安和一键呼叫家人。"],
  members: ["家庭成员", "已加入外婆、孙女和女儿，共 3 人。不同成员可以设置不同的查看与联系权限。"],
  devices: ["米家设备", "已连接 3 台设备。比赛 Demo 以手机摄像头模拟米家摄像机输入。"],
  time: ["关怀时间", "主动关怀时段为 08:00–22:00；夜间仅在检测到安全风险时提醒。"],
  security: ["数据与安全", "可查看授权记录、风险事件和本地数据清理状态。原始摄像头帧不进入云端。"],
};

export const DASHBOARD_HOTSPOTS = [
  ["range", "dashboard-range", "切换统计周期"],
  ["summary", "dashboard-summary", "查看本周陪伴摘要"],
  ["cooking", "dashboard-cooking", "查看做饭生活片段"],
  ["dialogue", "dashboard-dialogue", "播放对话摘要"],
  ["emotion", "dashboard-emotion", "查看情绪变化详情"],
  ["journey", "dashboard-journey", "查看心路历程"],
];

export const SETTINGS_HOTSPOTS = [
  ["family", "settings-family", "管理外婆家"],
  ["local", "settings-local", "查看本地处理说明"],
  ["sharing", "settings-sharing", "设置分享授权"],
  ["risk", "settings-risk", "设置风险提醒"],
  ["pin", "settings-pin", "查看 Reme Pin"],
  ["members", "settings-members", "查看家庭成员"],
  ["devices", "settings-devices", "查看米家设备"],
  ["time", "settings-time", "设置关怀时间"],
  ["security", "settings-security", "查看数据与安全"],
];
