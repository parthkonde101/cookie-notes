'use client';

import { useState } from 'react';
import { Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ActionButton } from '@/components/admin/action-button';
import {
  archiveFeedbackAction,
  featureFeedbackAction,
  markFeedbackReviewedAction,
  unfeatureFeedbackAction,
} from '@/app/admin/_actions/feedback';
import { formatDateTime } from '@/lib/utils';

export interface FeedbackRowData {
  id: string;
  message: string;
  status: 'PENDING' | 'REVIEWED' | 'ARCHIVED';
  featured: boolean;
  publicConsent: boolean;
  createdAt: string;
  userName: string;
  userEmail: string;
}

const STATUS_VARIANT = {
  PENDING: 'secondary',
  REVIEWED: 'default',
  ARCHIVED: 'outline',
} as const;

export function FeedbackRow({ feedback }: { feedback: FeedbackRowData }) {
  const [open, setOpen] = useState(false);

  return (
    <TableRow>
      <TableCell>
        <p className="font-medium">{feedback.userName}</p>
        <p className="text-xs text-muted-foreground">{feedback.userEmail}</p>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatDateTime(feedback.createdAt)}
      </TableCell>
      <TableCell className="max-w-xs">
        <p className="line-clamp-2 text-sm text-foreground/90">{feedback.message}</p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <Eye className="size-3" />
          Read full
        </button>
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[feedback.status]}>{feedback.status}</Badge>
      </TableCell>
      <TableCell>
        <Badge variant={feedback.publicConsent ? 'success' : 'outline'}>
          {feedback.publicConsent ? 'Consented' : 'No consent'}
        </Badge>
      </TableCell>
      <TableCell>
        {feedback.featured && <Badge variant="success">Featured</Badge>}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          {feedback.status === 'PENDING' && (
            <ActionButton
              size="sm"
              variant="outline"
              action={markFeedbackReviewedAction.bind(null, feedback.id)}
            >
              Mark reviewed
            </ActionButton>
          )}

          {!feedback.featured ? (
            <ActionButton
              size="sm"
              variant="outline"
              disabled={feedback.status !== 'REVIEWED' || !feedback.publicConsent}
              title={
                feedback.status !== 'REVIEWED'
                  ? 'Review this feedback first.'
                  : !feedback.publicConsent
                    ? "This student hasn't consented to public display."
                    : undefined
              }
              action={featureFeedbackAction.bind(null, feedback.id)}
            >
              Feature
            </ActionButton>
          ) : (
            <ActionButton
              size="sm"
              variant="outline"
              action={unfeatureFeedbackAction.bind(null, feedback.id)}
            >
              Unfeature
            </ActionButton>
          )}

          {feedback.status !== 'ARCHIVED' && (
            <ActionButton
              size="sm"
              variant="ghost"
              confirm={{
                title: 'Archive this feedback?',
                description:
                  'It moves out of the active queue and is removed from the homepage if featured. This can be reviewed again later if needed.',
                confirmLabel: 'Archive',
                destructive: true,
              }}
              action={archiveFeedbackAction.bind(null, feedback.id)}
            >
              Archive
            </ActionButton>
          )}
        </div>
      </TableCell>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{feedback.userName}</DialogTitle>
            <DialogDescription>
              {feedback.userEmail} · {formatDateTime(feedback.createdAt)}
            </DialogDescription>
          </DialogHeader>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {feedback.message}
          </p>
        </DialogContent>
      </Dialog>
    </TableRow>
  );
}
