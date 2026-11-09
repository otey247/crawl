import { useMutation } from '@tanstack/react-query';
import { Globe, Lock } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CrawlDetailDTO } from '@crawl/core';
import { Button, Field, Segmented, Sheet, errorMessage, inputCls, useToast } from '../components/ui';
import { api } from '../lib/api';

/** Organizer saves the crawl's stops and stay lengths as a reusable template. */
export function SaveTemplateSheet({ crawl, open, onClose }: { crawl: CrawlDetailDTO; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [title, setTitle] = useState(crawl.title);
  const [description, setDescription] = useState(crawl.description ?? '');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const save = useMutation({
    mutationFn: () => api.saveTemplate(crawl.id, { title, description: description || null, visibility }),
    onSuccess: (t) => {
      onClose();
      toast({ title: 'Template saved', body: visibility === 'public' ? 'Anyone can find it under Ready-made crawls.' : 'Only you can see it.' });
      nav(`/templates/${t.id}`);
    },
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  return (
    <Sheet open={open} onClose={onClose} title="Save as template">
      <form
        className="space-y-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="text-[14px] text-dim">Keeps the {crawl.stops.length} stops and how long you stay at each. Dates, people and photos aren’t included.</p>
        <Field label="Name">
          <input className={inputCls} required minLength={2} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="What makes it good">
          <textarea className={`${inputCls} h-20 py-3`} maxLength={400} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Segmented
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: 'public', label: 'Anyone', icon: <Globe className="size-4" /> },
            { value: 'private', label: 'Just me', icon: <Lock className="size-4" /> },
          ]}
        />
        <Button type="submit" className="w-full" loading={save.isPending}>
          Save template
        </Button>
      </form>
    </Sheet>
  );
}
