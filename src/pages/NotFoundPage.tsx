import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Panel } from '@/components/ui/Panel';
import { EmptyState } from '@/components/ui/States';
import { Button } from '@/components/ui/Button';

export function NotFoundPage() {
  return (
    <Panel>
      <EmptyState
        icon={<Compass size={22} strokeWidth={1.5} />}
        title="No such page"
        hint="That route is not part of the terminal."
        action={
          <Link to="/">
            <Button variant="primary">Back to dashboard</Button>
          </Link>
        }
      />
    </Panel>
  );
}
