import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, ChevronDown, Edit2, Plus, Search, Settings2,
  ShieldAlert, Trash2, UserPlus, Users, X, Zap
} from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

const ROLES = [
  { id: 'owner', label: 'Owner', hint: 'Team creator' },
  { id: 'admin', label: 'Admin', hint: 'Manage membership' },
  { id: 'member', label: 'Member', hint: 'View and contribute' }
];

async function request(path, token, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...options
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

export default function TeamWorkspace({ token, user }) {
  const [teams, setTeams] = useState([]);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deletingTeam, setDeletingTeam] = useState(null);
  const [removingMember, setRemovingMember] = useState(null);

  const loadTeams = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await request('/api/teams', token);
      setTeams(list);
      if (!selectedTeam && list.length) setSelectedTeam(list[0]);
    } catch (err) {
      setError(err.message || 'Failed to load teams.');
    } finally {
      setLoading(false);
    }
  }, [token, selectedTeam]);

  const loadMembers = useCallback(async (teamId) => {
    try {
      const list = await request(`/api/teams/${teamId}/members`, token);
      setMembers(list);
    } catch (err) {
      setMembers([]);
    }
  }, [token]);

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    if (selectedTeam) loadMembers(String(selectedTeam._id));
  }, [selectedTeam, loadMembers]);

  const isOwner = (team) => String(team.ownerId) === String(user?._id);
  const isAdminOrOwner = (team) => isOwner(team) || user?.role === 'admin';
  const myMembership = useMemo(() => {
    if (!selectedTeam) return null;
    return members.find((m) => String(m.userId) === String(user?._id)) ?? null;
  }, [selectedTeam, members, user]);
  const canManage = useMemo(() => isAdminOrOwner(selectedTeam) || (myMembership?.role === 'admin'), [selectedTeam, myMembership, user]);

  async function createTeam() {
    const name = window.prompt('Team name');
    if (!name || !name.trim()) return;
    try {
      await request('/api/teams', token, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      await loadTeams();
    } catch (err) {
      setError(err.message || 'Failed to create team.');
    }
  }

  async function renameTeam() {
    if (!selectedTeam) return;
    const name = window.prompt('Rename team', selectedTeam.name);
    if (!name || !name.trim()) return;
    setRenaming(true);
    try {
      await request(`/api/teams/${selectedTeam._id}`, token, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
      await loadTeams();
    } catch (err) {
      setError(err.message || 'Failed to rename team.');
    } finally {
      setRenaming(false);
    }
  }

  async function deleteTeam() {
    if (!selectedTeam || !window.confirm(`Delete team "${selectedTeam.name}"? Tasks and sprints will be detached.`)) return;
    setDeletingTeam(selectedTeam._id);
    try {
      await request(`/api/teams/${selectedTeam._id}`, token, { method: 'DELETE' });
      setTeams((current) => current.filter((t) => String(t._id) !== String(selectedTeam._id)));
      setSelectedTeam(null);
    } catch (err) {
      setError(err.message || 'Failed to delete team.');
    } finally {
      setDeletingTeam(null);
    }
  }

  async function inviteMember() {
    if (!selectedTeam) return;
    const userId = window.prompt(`Invite user to "${selectedTeam.name}"\nEnter the user's ID:`);
    if (!userId || !userId.trim()) return;
    setInviting(true);
    try {
      await request(`/api/teams/${selectedTeam._id}/members`, token, { method: 'POST', body: JSON.stringify({ userId: userId.trim() }) });
      await loadMembers(String(selectedTeam._id));
      await loadTeams();
    } catch (err) {
      setError(err.message || 'Failed to invite member.');
    } finally {
      setInviting(false);
    }
  }

  async function updateRole(memberId, role) {
    if (!selectedTeam) return;
    try {
      await request(`/api/teams/${selectedTeam._id}/members/${memberId}/role`, token, { method: 'PATCH', body: JSON.stringify({ role }) });
      await loadMembers(String(selectedTeam._id));
    } catch (err) {
      setError(err.message || 'Failed to update role.');
    }
  }

  async function removeMember(memberId) {
    if (!selectedTeam || !window.confirm('Remove this member from the team?')) return;
    setRemovingMember(memberId);
    try {
      await request(`/api/teams/${selectedTeam._id}/members/${memberId}`, token, { method: 'DELETE' });
      await loadMembers(String(selectedTeam._id));
    } catch (err) {
      setError(err.message || 'Failed to remove member.');
    } finally {
      setRemovingMember(null);
    }
  }

  const roleLabel = (role) => ROLES.find((r) => r.id === role)?.label || role;

  return (
    <div className="team-workspace">
      <div className="tw-header">
        <h2>Team &amp; Workspace</h2>
        <p>Manage teams, membership, and roles. Tasks and sprints belong to teams.</p>
      </div>

      {error && <div className="tw-alert" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}

      <div className="tw-grid">
        <aside className="tw-sidebar">
          <div className="tw-section">
            <label className="tw-section-label">Your Teams</label>
            <button className="tw-button tw-button-secondary" onClick={createTeam} disabled={loading}>
              <Plus size={14} /> New Team
            </button>
            {loading ? <div className="tw-loading">Loading teams&hellip;</div> : (
              <div className="tw-team-list">
                {teams.map((team) => (
                  <button key={team._id} className={`tw-team-item ${String(selectedTeam?._id) === String(team._id) ? 'tw-team-item-active' : ''}`} onClick={() => setSelectedTeam(team)}>
                    <div className="tw-team-info">
                      <div className="tw-team-name">{team.name}</div>
                      <div className="tw-team-meta">{isOwner(team) ? 'Owner' : myMembership?.role || 'Member'} &middot; {team.ownerId ? String(team.ownerId).slice(-6) : ''}</div>
                    </div>
                    {canManage && <button className="tw-icon-button" onClick={(e) => { e.stopPropagation(); deleteTeam(); }} title="Delete team"><Trash2 size={13} /></button>}
                  </button>
                ))}
                {teams.length === 0 && <div className="tw-empty">No teams yet. Create your first team.</div>}
              </div>
            )}
          </div>
        </aside>
        <main className="tw-main">
          {!selectedTeam ? (
            <div className="tw-empty-state">
              <Users size={32} />
              <p>Select a team to manage its members and roles.</p>
            </div>
          ) : (
            <div className="tw-detail">
              <div className="tw-detail-header">
                <div>
                  <div className="tw-detail-title">{selectedTeam.name}</div>
                  <div className="tw-detail-sub">Team ID: {String(selectedTeam._id).slice(-8)}</div>
                </div>
                <div className="tw-detail-actions">
                  {canManage && (
                    <button className="tw-button tw-button-secondary" onClick={renameTeam} disabled={renaming}>
                      <Edit2 size={14} /> Rename
                    </button>
                  )}
                  {canManage && selectedTeam && (
                    <button className="tw-button tw-button-danger" onClick={deleteTeam} disabled={deletingTeam}>
                      <Trash2 size={14} /> Delete Team
                    </button>
                  )}
                </div>
              </div>

              <div className="tw-section">
                <label className="tw-section-label">Members ({members.length})</label>
                <div className="tw-member-list">
                  {members.map((m) => {
                    const isMe = String(m.userId) === String(user?._id);
                    const isOwnerRole = String(selectedTeam.ownerId) === String(m.userId);
                    const canEditRole = canManage && !isOwnerRole && !isMe;
                    return (
                      <div key={m.userId} className="tw-member-item">
                        <div className="tw-member-info">
                          <div className="tw-member-avatar">{initialsOf(m.userId)}</div>
                          <div>
                            <div className="tw-member-id">{m.userId}</div>
                            <div className="tw-member-meta">{isOwnerRole ? 'Owner' : roleLabel(m.role)} &middot; joined {new Date(m.joinedAt).toLocaleDateString()}</div>
                          </div>
                        </div>
                        <div className="tw-member-actions">
                          {canEditRole && (
                            <select value={m.role} onChange={(e) => updateRole(m.userId, e.target.value)} disabled={removingMember === m.userId} className="tw-role-select">
                              {ROLES.filter((r) => r.id !== 'owner').map((r) => (<option key={r.id} value={r.id}>{r.label}</option>))}
                            </select>
                          )}
                          {!isMe && !isOwnerRole && canManage && (
                            <button className="tw-button tw-button-danger tw-button-sm" onClick={() => removeMember(m.userId)} disabled={removingMember === m.userId}>
                              Remove
                            </button>
                          )}
                          {isMe && !isOwnerRole && canManage && (
                            <button className="tw-button tw-button-danger tw-button-sm" onClick={() => removeMember(m.userId)} disabled={removingMember === m.userId}>
                              Leave Team
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {members.length === 0 && <div className="tw-empty">No members yet.</div>}
                </div>
              </div>

              <div className="tw-section">
                <label className="tw-section-label">Invite Member</label>
                <div className="tw-invite">
                  <input type="text" placeholder="User ID" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} disabled={inviting} />
                  <button className="tw-button tw-button-primary" onClick={inviteMember} disabled={inviting || !inviteEmail.trim()}>
                    {inviting ? <><Zap size={13} /> Inviting&hellip;</> : <><UserPlus size={13} /> Invite</>}
                  </button>
                </div>
                <p className="tw-hint">Ask the person for their LeadAI user ID. Team owners and admins can invite members.</p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}