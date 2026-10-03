// 中俄双语词条：清单表头与状态标签。
export const LABELS = {
  name_zh: { zh: "姓名（中）", ru: "Имя (кит.)" },
  name_ru: { zh: "姓名（俄）", ru: "Имя (рус.)" },
  role: { zh: "角色", ru: "Роль" },
  languages: { zh: "语言需求", ru: "Языки" },
  eligibility_status: { zh: "跨境资格", ru: "Допуск через границу" },
  insurance_status: { zh: "保险", ru: "Страховка" },
  emergency_contact: { zh: "紧急联系人", ru: "Экстренный контакт" },
  document_ref: { zh: "证件号", ru: "Документ" },
  birth_date: { zh: "出生日期", ru: "Дата рождения" },
  room: { zh: "房间", ru: "Комната" },
  vehicle: { zh: "车辆", ru: "Автобус" },
  seat: { zh: "席位", ru: "Место" },
  group_name: { zh: "团组", ru: "Группа" },
};

export const STATUS = {
  confirmed: { zh: "已确认", ru: "Подтверждено" },
  pending: { zh: "待确认", ru: "Ожидает" },
  missing: { zh: "缺失", ru: "Отсутствует" },
  valid: { zh: "有效", ru: "Действует" },
  expired: { zh: "已过期", ru: "Истекла" },
  leader: { zh: "领队", ru: "Руководитель" },
  member: { zh: "成员", ru: "Участник" },
};

export function bilingual(dict, key) {
  const entry = dict[key];
  return entry ? `${entry.zh} / ${entry.ru}` : key;
}

export function statusLabel(key) {
  return bilingual(STATUS, key);
}
