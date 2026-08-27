import { ImagePlus, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import type { PhotoNote } from "@/lib/face-db";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 把图片压到长边 1024，转成 dataURL 存本地 */
async function toDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t("读取图片失败")));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(t("读取图片失败")));
    el.src = raw;
  });
  const max = 1024;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  if (scale === 1 && raw.length < 400_000) return raw;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return raw;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

interface Props {
  photos: PhotoNote[];
  onChange: (next: PhotoNote[]) => void;
  label?: string;
  className?: string;
}

/** 图片备注：上传或 Ctrl/⌘+V 粘贴，每张可以写一句说明 */
export function PhotoNotes({ photos, onChange, label, className }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<PhotoNote | null>(null);

  const addFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    try {
      const added: PhotoNote[] = [];
      for (const file of images) {
        added.push({
          id: crypto.randomUUID(),
          dataUrl: await toDataUrl(file),
          caption: "",
          addedAt: Date.now(),
        });
      }
      onChange([...photos, ...added]);
      toast.success(`${t("已添加")} ${added.length} ${t("张图片")}`);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        {label ?? t("图片备注")}
      </p>

      <div
        tabIndex={0}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length) {
            event.preventDefault();
            void addFiles(files);
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void addFiles([...event.dataTransfer.files]);
        }}
        className="rounded-lg border border-dashed border-border p-3 outline-none focus:border-primary"
      >
        <div className="flex flex-wrap gap-2">
          {photos.map((photo) => (
            <div key={photo.id} className="w-28 space-y-1">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setPreview(photo)}
                  className="block w-full overflow-hidden rounded-md border border-border"
                >
                  <img
                    src={photo.dataUrl}
                    alt={photo.caption || t("图片备注")}
                    className="h-20 w-full object-cover"
                  />
                </button>
                <button
                  type="button"
                  aria-label={t("删除")}
                  onClick={() => onChange(photos.filter((item) => item.id !== photo.id))}
                  className="absolute right-1 top-1 rounded-full bg-background/85 p-1 text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              </div>
              <Input
                value={photo.caption ?? ""}
                onChange={(event) =>
                  onChange(
                    photos.map((item) =>
                      item.id === photo.id ? { ...item, caption: event.target.value } : item,
                    ),
                  )
                }
                placeholder={t("说明一句")}
                className="h-7 text-[11px]"
              />
            </div>
          ))}

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex h-20 w-28 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            <ImagePlus className="size-4" aria-hidden="true" />
            {t("加图片")}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("点这个框再 Ctrl/⌘+V 粘贴，也可以直接拖进来")}
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          void addFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />

      {preview && (
        <div
          role="presentation"
          onClick={() => setPreview(null)}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-background/85 p-6 backdrop-blur"
        >
          <div className="max-h-full max-w-3xl overflow-auto rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{preview.caption}</span>
              <X className="size-4 text-muted-foreground" aria-hidden="true" />
            </div>
            <img
              src={preview.dataUrl}
              alt={preview.caption || t("图片备注")}
              className="max-h-[70vh]"
            />
          </div>
        </div>
      )}
    </div>
  );
}
