import { cn } from "@/lib/utils";

/** 头像底色色相池：同一档案 ID 永远拿到同一颜色，与姓名、性别无关。 */
const AVATAR_HUES = [8, 32, 88, 152, 190, 220, 262, 310] as const;

function avatarHue(id: string) {
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return AVATAR_HUES[hash % AVATAR_HUES.length];
}

/**
 * 档案默认头像：有照片用照片，没有则显示姓名首字加按档案 ID 稳定生成的底色。
 * 不依据性别或任何推断属性。
 */
export function PersonAvatar({
  name,
  id,
  thumb,
  className,
}: {
  name: string;
  id: string;
  thumb?: string;
  className?: string;
}) {
  if (thumb) {
    return (
      <img src={thumb} alt={name} className={cn("shrink-0 rounded-lg object-cover", className)} />
    );
  }
  const hue = avatarHue(id);
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg text-base font-medium",
        className,
      )}
      style={{
        backgroundColor: `hsl(${hue} 42% 86%)`,
        color: `hsl(${hue} 45% 30%)`,
      }}
    >
      {name.trim().slice(0, 1) || "?"}
    </div>
  );
}
