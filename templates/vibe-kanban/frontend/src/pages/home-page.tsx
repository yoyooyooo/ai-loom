import { useEffect, useState } from 'react';
import { useConfig } from '@/contexts/config-context';
import type { Entity } from 'shared/types';

export function HomePage() {
  const { apiBaseUrl } = useConfig();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchEntities();
  }, []);

  const fetchEntities = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${apiBaseUrl}/entities`);
      if (!response.ok) {
        throw new Error('Failed to fetch entities');
      }
      const data = await response.json();
      setEntities(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center text-red-600">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Vibe Starter</h1>
      
      <div className="grid gap-4">
        {entities.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No entities found. Create your first entity to get started.
          </div>
        ) : (
          entities.map((entity) => (
            <div
              key={entity.id}
              className="border rounded-lg p-4 hover:shadow-md transition-shadow"
            >
              <h3 className="font-semibold">{entity.name}</h3>
              {entity.description && (
                <p className="text-muted-foreground mt-1">{entity.description}</p>
              )}
              <div className="text-sm text-muted-foreground mt-2">
                Created: {new Date(entity.created_at).toLocaleDateString()}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
