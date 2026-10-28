window.__ModuleLoader__.load({
  id: 'dsh-subagent-remote',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    // Optional DSH client primitives: if the module or a component disappears in a
    // future release, fall back to plain HTML controls instead of breaking the page.
    const primitives = (() => {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return {} }
    })();
    function FallbackButton(props) {
      const { variant, size, className, children, onClick, disabled, icon, ...rest } = props;
      return h('button', {
        type: 'button',
        className: ['dsr-btn', variant === 'primary' ? 'dsr-btn-primary' : '', className || ''].filter(Boolean).join(' '),
        onClick, disabled, ...rest,
      }, icon, children);
    }
    function FallbackInput(props) {
      return h('input', props);
    }
    function FallbackSegmented(props) {
      const { id, value, options, onChange, label, disabled } = props;
      return h('div', { role: 'tablist', 'aria-label': label, className: 'dsr-fallback-segmented', id },
        (options || []).map((option) => h('button', {
          key: option.value,
          type: 'button',
          role: 'tab',
          'aria-selected': option.value === value,
          disabled,
          onClick: () => onChange(option.value),
        }, option.label)));
    }
    function FallbackSwitch(props) {
      const { checked, onChange, label, disabled } = props;
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked === true, disabled,
        onClick: () => onChange(checked !== true),
      }, checked === true ? '●' : '○', label ? h('span', null, ' ' + label) : null);
    }
    function FallbackPill(props) {
      return h('span', { className: 'dsr-badge' }, props.children);
    }
    const Button = primitives.Button || FallbackButton;
    const Input = primitives.Input || FallbackInput;
    const SegmentedControl = primitives.SegmentedControl || FallbackSegmented;
    const Switch = primitives.Switch || FallbackSwitch;
    const Pill = primitives.Pill || FallbackPill;

    const PACKAGE_NAME = 'dsh-subagent-remote';
    const RPC_ENDPOINT = 'dsh-subagent-remote';
    const NS = 'dsh-subagent-remote';
    const PANEL_ID = 'dsh-subagent-remote-config';
    const STYLE_ID = 'dsr-settings-style';
    const PERMISSIONS = ['read-only', 'ask', 'deny', 'auto'];
    const PERMISSION_KEYS = { 'read-only': 'permissionReadOnly', ask: 'permissionAsk', deny: 'permissionDeny', auto: 'permissionAuto' };

    const zh = {
      title: '远端子智能体',
      openConfig: '打开配置',
      back: '返回插件详情',
      subtitle: 'profile 配置是基线，本页修改写入插件 JSON 覆盖层并立即生效；直接编辑 JSON 文件则需重启。',
      addHost: '添加主机',
      addHostTitle: '添加主机',
      refresh: '刷新',
      hostCount: '当前 {count} 台主机',
      defaultSuffix: '，默认 {name}',
      pendingSuffix: '（有外部改动待重启）',
      emptyList: '尚未配置任何远端主机，点击「添加主机」开始。',
      reading: '正在读取主机配置…',
      readError: '无法读取远端主机配置：',
      pendingBanner: '检测到外部文件改动，重启 DSH 后生效：',
      setDefault: '设为默认',
      probe: '测试连接',
      probing: '检测中…',
      edit: '编辑',
      disable: '禁用',
      enable: '启用',
      deleteHost: '删除主机',
      revert: '恢复 YAML 值',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      addAndApply: '添加',
      nameLabel: '主机名（唯一）',
      sshLabel: 'SSH 目标（别名或 user@host）',
      cwdLabel: '远端工作区（绝对路径）',
      permissionLabel: '权限策略',
      sessionLabel: '远端会话',
      scrubLabel: 'env scrub（剔除凭证形变量）',
      agentLabel: '期望 agent 名（可选）',
      metaTarget: '目标',
      metaCwd: '工作区',
      metaPermission: '权限',
      metaSession: '远端会话',
      metaScrub: 'env scrub',
      on: '开',
      off: '关',
      permissionReadOnly: '只读',
      permissionAsk: '询问',
      permissionDeny: '拒绝',
      permissionAuto: '自动',
      sessionClose: '结束后关闭',
      sessionKeep: '保留历史',
      badgeDefault: '默认',
      badgeOverlay: '覆盖层',
      badgeDisabled: '已禁用',
      defaultSource: '默认主机来源：',
      sourceSettings: '本页选择',
      sourceConfig: 'profile 配置',
      sourceNone: '未设置（单主机时自动使用）',
      stateFile: '状态文件：',
      sessionSwitch: '会话内切换：/remote-host <名字>',
      applied: '已生效',
      appliedUpdated: '已生效：更新 {names}',
      appliedAdded: '已生效：新增 {names}',
      appliedRemoved: '已生效：移除 {names}',
      statusDefaultSwitched: '默认主机已切换',
      statusDisabled: '已禁用',
      statusEnabled: '已启用',
      statusDeleted: '已删除主机',
      statusReverted: '已恢复 YAML 值',
      probeOk: '连通：',
      probeFail: '失败：',
      noteDisabledYaml: '已禁用：provider 已下线，YAML 基线定义保留；点「启用」恢复。',
      noteDisabledOverlay: '覆盖层新增的主机已禁用；可「启用」或「删除主机」。',
      noteAddHost: '新主机写入插件 JSON 覆盖层并立即注册，无需重启。',
      emptyName: '主机名不能为空',
      emptySsh: 'SSH 目标不能为空',
      emptyCwd: '工作区路径不能为空',
      hostSuffixMs: 'ms',
    };

    const en = {
      title: 'Remote subagents',
      openConfig: 'Open configuration',
      back: 'Back to plugin',
      subtitle: 'The profile patch is the baseline; edits here are written to the plugin JSON overlay and apply immediately. Editing the JSON file directly needs a restart.',
      addHost: 'Add host',
      addHostTitle: 'Add host',
      refresh: 'Refresh',
      hostCount: '{count} host(s)',
      defaultSuffix: ', default {name}',
      pendingSuffix: ' (external edits pending restart)',
      emptyList: 'No remote hosts configured yet. Use "Add host" to start.',
      reading: 'Reading host configuration…',
      readError: 'Cannot read remote host configuration: ',
      pendingBanner: 'External file edits detected; restart DSH to apply: ',
      setDefault: 'Set as default',
      probe: 'Test connection',
      probing: 'Testing…',
      edit: 'Edit',
      disable: 'Disable',
      enable: 'Enable',
      deleteHost: 'Delete host',
      revert: 'Restore YAML value',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      addAndApply: 'Add',
      nameLabel: 'Host name (unique)',
      sshLabel: 'SSH target (alias or user@host)',
      cwdLabel: 'Remote workspace (absolute path)',
      permissionLabel: 'Permission policy',
      sessionLabel: 'Remote session',
      scrubLabel: 'env scrub (drop credential-like vars)',
      agentLabel: 'Expected agent name (optional)',
      metaTarget: 'Target',
      metaCwd: 'Workspace',
      metaPermission: 'Permission',
      metaSession: 'Remote session',
      metaScrub: 'env scrub',
      on: 'on',
      off: 'off',
      permissionReadOnly: 'read-only',
      permissionAsk: 'ask',
      permissionDeny: 'deny',
      permissionAuto: 'auto',
      sessionClose: 'close when finished',
      sessionKeep: 'keep history',
      badgeDefault: 'default',
      badgeOverlay: 'overlay',
      badgeDisabled: 'disabled',
      defaultSource: 'Default host source: ',
      sourceSettings: 'this page',
      sourceConfig: 'profile config',
      sourceNone: 'not set (single host is used automatically)',
      stateFile: 'State file: ',
      sessionSwitch: 'In-session switching: /remote-host <name>',
      applied: 'Applied',
      appliedUpdated: 'Applied: updated {names}',
      appliedAdded: 'Applied: added {names}',
      appliedRemoved: 'Applied: removed {names}',
      statusDefaultSwitched: 'Default host switched',
      statusDisabled: 'Disabled',
      statusEnabled: 'Enabled',
      statusDeleted: 'Host deleted',
      statusReverted: 'YAML value restored',
      probeOk: 'reachable: ',
      probeFail: 'failed: ',
      noteDisabledYaml: 'Disabled: the provider is offline but the YAML baseline remains; use Enable to restore.',
      noteDisabledOverlay: 'This overlay host is disabled; enable it or delete it.',
      noteAddHost: 'The new host is written to the plugin JSON overlay and registered immediately — no restart.',
      emptyName: 'Host name is required',
      emptySsh: 'SSH target is required',
      emptyCwd: 'Workspace path is required',
      hostSuffixMs: 'ms',
    };

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values && values[key] !== undefined ? String(values[key]) : match));
    }

    // Visual layer follows DSH design tokens and primitives; only the page shell
    // (padding, card grouping, meta grid) is ours.
    const styles = `
.dsr-page { display:flex; flex-direction:column; gap:20px; max-width:900px; margin:0 auto; padding:20px 28px 36px; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); }
.dsr-backRow { display:flex; align-items:center; }
.dsr-head { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }
.dsr-title { font-size:16px; font-weight:600; line-height:24px; }
.dsr-sub { margin-top:6px; font-size:12px; line-height:18px; color: var(--dsw-alias-label-secondary); }
.dsr-status { margin-top:4px; font-size:12px; line-height:18px; color: var(--dsw-alias-label-secondary); }
.dsr-card { border:1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); padding:16px 20px; display:flex; flex-direction:column; gap:12px; }
.dsr-card-disabled { opacity:.55; }
.dsr-host-name { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:13px; font-weight:600; line-height:20px; }
.dsr-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:6px 24px; font-size:12px; line-height:18px; color: var(--dsw-alias-label-secondary); }
.dsr-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.dsr-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:18px 24px; }
.dsr-field { display:flex; flex-direction:column; gap:8px; min-width:0; }
.dsr-fieldLabel { font-size:12px; line-height:20px; color: var(--dsw-alias-label-secondary); }
.dsr-controlRow { display:flex; align-items:center; width:100%; min-height:36px; }
.dsr-controlRow > span { width:100%; box-sizing:border-box; }
.dsr-controlRow > [role="tablist"] { width:100%; }
.dsr-note { font-size:12px; line-height:18px; color: var(--dsw-alias-label-tertiary); }
.dsr-card > .dsr-note { margin-top: -2px; }
.dsr-notice { font-size:12px; line-height:18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); padding:8px 12px; }
.dsr-err { font-size:12px; line-height:18px; color: var(--dsw-alias-label-error); }
.dsr-ok { font-size:12px; line-height:18px; color: var(--dsw-alias-state-success-primary); }
.dsr-form-edit { grid-template-columns:repeat(2, minmax(0,1fr)); gap:20px 24px; }
.dsr-formFooter { grid-column:1 / -1; display:flex; justify-content:flex-end; align-items:center; gap:12px; border-top:1px solid var(--dsw-alias-border-l2); padding-top:16px; margin-top:6px; }
@media (max-width: 760px) { .dsr-form-edit { grid-template-columns:minmax(0,1fr); } }
.dsr-dangerText { color: var(--dsw-alias-label-error); }
.dsr-fallback-segmented { display:flex; gap:4px; }
.dsr-fallback-segmented > button { font-size:12px; padding:4px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:inherit; cursor:pointer; }
.dsr-fallback-segmented > button[aria-selected="true"] { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l4); }
`

    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.textContent = styles;
      document.head.appendChild(tag);
    }

    function unwrap(response) {
      const body = response !== null && typeof response === 'object' && 'result' in response ? response.result : response;
      if (body !== null && typeof body === 'object' && body.ok === false) {
        const message = body.error && typeof body.error.message === 'string' ? body.error.message : 'request failed';
        throw new Error(message);
      }
      return body !== null && typeof body === 'object' ? (body.value === undefined ? body : body.value) : body;
    }

    function rpc(connection, method, payload) {
      return connection.rpc.call('/api', RPC_ENDPOINT, { method: method, payload: payload || {} }).then(unwrap);
    }

    function Field(props) {
      return h('div', { className: 'dsr-field' },
        h('span', { className: 'dsr-fieldLabel' }, props.label),
        props.children);
    }

    function Badge(props) {
      return h(Pill, null, props.children);
    }

    function useHostFields(initial) {
      const [ssh, setSsh] = React.useState(initial?.ssh || '');
      const [cwd, setCwd] = React.useState(initial?.cwd || '');
      const [permission, setPermission] = React.useState(initial?.permission || 'read-only');
      const [remoteSession, setRemoteSession] = React.useState(initial?.remoteSession || 'close');
      const [scrubEnv, setScrubEnv] = React.useState(initial?.scrubEnv === true);
      const [expectedAgent, setExpectedAgent] = React.useState(initial?.expectedAgent || '');
      return {
        values: { ssh: ssh, cwd: cwd, permission: permission, remoteSession: remoteSession, scrubEnv: scrubEnv, expectedAgent: expectedAgent },
        setters: { setSsh: setSsh, setCwd: setCwd, setPermission: setPermission, setRemoteSession: setRemoteSession, setScrubEnv: setScrubEnv, setExpectedAgent: setExpectedAgent },
      };
    }

    function renderFields(fields, t, showSsh) {
      const v = fields.values;
      const s = fields.setters;
      return [
        showSsh
          ? h(Field, { key: 'ssh', label: t('sshLabel') },
            h('div', { className: 'dsr-controlRow' }, h(Input, { value: v.ssh, onChange: (e) => s.setSsh(e.target.value), placeholder: 'example-host' })))
          : null,
        h(Field, { key: 'cwd', label: t('cwdLabel') },
          h('div', { className: 'dsr-controlRow' }, h(Input, { value: v.cwd, onChange: (e) => s.setCwd(e.target.value), placeholder: '/srv/work' }))),
        h(Field, { key: 'permission', label: t('permissionLabel') },
          h('div', { className: 'dsr-controlRow' }, h(SegmentedControl, {
            id: 'dsr-permission',
            value: v.permission,
            label: t('permissionLabel'),
            options: PERMISSIONS.map((value) => ({ value: value, label: t(PERMISSION_KEYS[value]) })),
            onChange: (value) => s.setPermission(value),
          }))),
        h(Field, { key: 'session', label: t('sessionLabel') },
          h('div', { className: 'dsr-controlRow' }, h(SegmentedControl, {
            id: 'dsr-session',
            value: v.remoteSession,
            label: t('sessionLabel'),
            options: [
              { value: 'close', label: t('sessionClose') },
              { value: 'keep', label: t('sessionKeep') },
            ],
            onChange: (value) => s.setRemoteSession(value),
          }))),
        h(Field, { key: 'scrub', label: t('scrubLabel') },
          h('div', { className: 'dsr-controlRow' }, h(Switch, { checked: v.scrubEnv, onChange: (checked) => s.setScrubEnv(checked), label: t('scrubLabel') }))),
        h(Field, { key: 'agent', label: t('agentLabel') },
          h('div', { className: 'dsr-controlRow' }, h(Input, { value: v.expectedAgent, onChange: (e) => s.setExpectedAgent(e.target.value), placeholder: 'deepseek-harness-acp' }))),
      ].filter(Boolean);
    }

    function HostEditForm(props) {
      const { host, connection, t, onSaved, onCancel } = props;
      const fields = useHostFields({
        ssh: host.overlay && host.overlay.ssh ? host.overlay.ssh : (host.live.endpoint || '').replace(/^ssh:/, ''),
        cwd: host.cwd,
        permission: host.permission,
        remoteSession: host.remoteSession,
        scrubEnv: host.envScrubbed,
        expectedAgent: host.expectedAgent || '',
      });
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      const submit = async () => {
        setBusy(true);
        setError(null);
        try {
          const values = fields.values;
          const patch = { cwd: values.cwd, permission: values.permission, remoteSession: values.remoteSession, scrubEnv: values.scrubEnv };
          if (values.ssh.trim().length > 0) patch.ssh = values.ssh.trim();
          if (values.expectedAgent.trim().length > 0) patch.expectAgentName = values.expectedAgent.trim();
          const result = await rpc(connection, 'setHost', { name: host.name, patch: patch });
          await onSaved(result && result.apply);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'dsr-form dsr-form-edit' },
        renderFields(fields, t, true),
        error === null ? null : h('div', { className: 'dsr-err', style: { gridColumn: '1 / -1' } }, error),
        h('div', { className: 'dsr-formFooter' },
          h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: onCancel }, t('cancel')),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: submit }, busy ? t('saving') : t('save'))));
    }

    function AddHostForm(props) {
      const { connection, t, onSaved, onCancel } = props;
      const [name, setName] = React.useState('');
      const fields = useHostFields({ cwd: '', permission: 'read-only', remoteSession: 'close', scrubEnv: true });
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      const submit = async () => {
        setBusy(true);
        setError(null);
        try {
          const hostName = name.trim();
          if (hostName.length === 0) throw new Error(t('emptyName'));
          const values = fields.values;
          if (values.ssh.trim().length === 0) throw new Error(t('emptySsh'));
          if (values.cwd.trim().length === 0) throw new Error(t('emptyCwd'));
          const patch = {
            ssh: values.ssh.trim(),
            cwd: values.cwd.trim(),
            permission: values.permission,
            remoteSession: values.remoteSession,
            scrubEnv: values.scrubEnv,
          };
          if (values.expectedAgent.trim().length > 0) patch.expectAgentName = values.expectedAgent.trim();
          const result = await rpc(connection, 'setHost', { name: hostName, patch: patch });
          await onSaved(result && result.apply);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'dsr-card' },
        h('div', { className: 'dsr-host-name' }, t('addHostTitle')),
        h('div', { className: 'dsr-form dsr-form-edit' },
          h(Field, { label: t('nameLabel') },
            h('div', { className: 'dsr-controlRow' }, h(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: 'nas' }))),
          renderFields(fields, t, true),
          error === null ? null : h('div', { className: 'dsr-err', style: { gridColumn: '1 / -1' } }, error),
          h('div', { className: 'dsr-formFooter' },
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: onCancel }, t('cancel')),
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: submit }, busy ? t('saving') : t('addAndApply')))),
        h('div', { className: 'dsr-note' }, t('noteAddHost')));
    }

    function summaryOf(apply, t) {
      if (apply === null || apply === undefined) return t('applied');
      const parts = [];
      if (Array.isArray(apply.added) && apply.added.length > 0) parts.push(format(t('appliedAdded'), { names: apply.added.join(', ') }));
      if (Array.isArray(apply.updated) && apply.updated.length > 0) parts.push(format(t('appliedUpdated'), { names: apply.updated.join(', ') }));
      if (Array.isArray(apply.removed) && apply.removed.length > 0) parts.push(format(t('appliedRemoved'), { names: apply.removed.join(', ') }));
      return parts.length === 0 ? t('applied') : parts.join('；');
    }

    function HostCard(props) {
      const { host, isDefault, connection, t, onChanged } = props;
      const [busy, setBusy] = React.useState(false);
      const [probe, setProbe] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [editing, setEditing] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const disabled = host.disabled === true;
      const overlayAdded = host.yamlBacked === false;
      const hasOverlay = host.fromOverlay === true;

      React.useEffect(() => {
        if (status === null) return undefined;
        const timer = setTimeout(() => setStatus(null), 4000);
        return () => clearTimeout(timer);
      }, [status]);

      const run = async (operation, label) => {
        setBusy(true);
        setError(null);
        try {
          const result = await operation();
          setStatus(label + (result && result.apply ? '（' + summaryOf(result.apply, t) + '）' : ''));
          await onChanged();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      const makeDefault = () => run(() => rpc(connection, 'setDefaultHost', { name: host.name }), t('statusDefaultSwitched'));
      const runProbe = async () => {
        setBusy(true);
        setProbe(null);
        setError(null);
        try {
          setProbe(await rpc(connection, 'probe', { name: host.name }));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };
      const disableHost = () => run(() => rpc(connection, 'setHost', { name: host.name, patch: { disabled: true } }), t('statusDisabled'));
      const enableHost = () => run(() => rpc(connection, 'setHost', { name: host.name, patch: { disabled: false } }), t('statusEnabled'));
      const deleteHost = () => run(() => rpc(connection, 'resetHost', { name: host.name }), t('statusDeleted'));
      const revertHost = () => run(() => rpc(connection, 'resetHost', { name: host.name }), t('statusReverted'));

      return h('div', { className: 'dsr-card' + (disabled ? ' dsr-card-disabled' : '') },
        h('div', { className: 'dsr-host-name' },
          host.name,
          isDefault && !disabled ? h(Badge, null, t('badgeDefault')) : null,
          disabled ? h(Badge, null, t('badgeDisabled')) : null,
          hasOverlay ? h(Badge, null, t('badgeOverlay')) : null,
          status !== null ? h(Badge, null, status) : null),
        editing
          ? null
          : h('div', { className: 'dsr-meta' },
            h('span', null, t('metaTarget') + '：' + host.endpoint),
            h('span', null, t('metaCwd') + '：' + host.cwd),
            h('span', null, t('metaPermission') + '：' + t(PERMISSION_KEYS[host.permission] ?? host.permission)),
            h('span', null, t('metaSession') + '：' + (host.remoteSession === 'keep' ? t('sessionKeep') : t('sessionClose'))),
            h('span', null, t('metaScrub') + '：' + (host.envScrubbed ? t('on') : t('off')))),
        editing
          ? h(HostEditForm, {
            host: host,
            connection: connection,
            t: t,
            onCancel: () => setEditing(false),
            onSaved: async (apply) => {
              setEditing(false);
              setStatus(summaryOf(apply, t));
              await onChanged();
            },
          })
          : h('div', { className: 'dsr-row' },
            disabled
              ? h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: enableHost }, t('enable'))
              : h(Button, { variant: 'outline', size: 'sm', disabled: busy || isDefault, onClick: makeDefault }, t('setDefault')),
            disabled
              ? null
              : h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: runProbe }, busy ? t('probing') : t('probe')),
            disabled
              ? null
              : h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setEditing(true) }, t('edit')),
            disabled
              ? null
              : h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: disableHost }, t('disable')),
            overlayAdded
              ? h(Button, { variant: 'ghost', size: 'sm', className: 'dsr-dangerText', disabled: busy, onClick: deleteHost }, t('deleteHost'))
              : null,
            hasOverlay && !overlayAdded
              ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: revertHost }, t('revert'))
              : null),
        disabled
          ? h('div', { className: 'dsr-note' }, overlayAdded ? t('noteDisabledOverlay') : t('noteDisabledYaml'))
          : null,
        probe === null ? null : h('div', { className: probe.ok ? 'dsr-ok' : 'dsr-err' },
          (probe.ok ? t('probeOk') : t('probeFail')) + probe.detail + '（' + probe.durationMs + ' ' + t('hostSuffixMs') + '）'),
        error === null ? null : h('div', { className: 'dsr-err' }, error));
    }

    function SettingsSection(props) {
      const { connection, t } = props;
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [adding, setAdding] = React.useState(false);
      const [addStatus, setAddStatus] = React.useState(null);

      const refresh = React.useCallback(async () => {
        setError(null);
        try {
          setState(await rpc(connection, 'state', {}));
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, [connection]);

      React.useEffect(() => {
        ensureStyles();
        refresh();
      }, [refresh]);

      if (error !== null) return h('div', { className: 'dsr-page' }, h('div', { className: 'dsr-err' }, t('readError') + error));
      if (state === null) return h('div', { className: 'dsr-page' }, h('div', { className: 'dsr-note' }, t('reading')));

      return h('div', { className: 'dsr-page' },
        h('div', { className: 'dsr-head' },
          h('div', null,
            h('div', { className: 'dsr-title' }, t('title')),
            h('div', { className: 'dsr-sub' }, t('subtitle')),
            h('div', { className: 'dsr-status' },
              format(t('hostCount'), { count: state.hosts.length })
              + (state.defaultHost ? format(t('defaultSuffix'), { name: state.defaultHost }) : '')
              + (state.pendingHostEdits.length > 0 ? t('pendingSuffix') : ''))),
          h('div', { className: 'dsr-row' },
            h(Button, { variant: 'primary', size: 'sm', onClick: () => setAdding(true) }, t('addHost')),
            h(Button, { variant: 'ghost', size: 'sm', onClick: refresh }, t('refresh')))),
        state.pendingHostEdits.length > 0
          ? h('div', { className: 'dsr-notice' }, t('pendingBanner') + state.pendingHostEdits.join('、'))
          : null,
        addStatus !== null ? h('div', { className: 'dsr-ok' }, addStatus) : null,
        adding
          ? h(AddHostForm, {
            connection: connection,
            t: t,
            onCancel: () => setAdding(false),
            onSaved: async (apply) => {
              setAdding(false);
              setAddStatus(summaryOf(apply, t));
              await refresh();
            },
          })
          : null,
        state.hosts.length === 0
          ? h('div', { className: 'dsr-note' }, t('emptyList'))
          : state.hosts.map((host) => h(HostCard, {
            key: host.name,
            host: host,
            connection: connection,
            t: t,
            isDefault: state.defaultHost === host.name,
            onChanged: refresh,
          })),
        h('div', { className: 'dsr-note' },
          t('defaultSource')
          + (state.defaultSource === 'settings' ? t('sourceSettings') : state.defaultSource === 'config' ? t('sourceConfig') : t('sourceNone'))
          + ' ｜ ' + t('stateFile') + state.stateFile
          + ' ｜ ' + t('sessionSwitch')));
    }

    function OpenConfigAction({ subject, packageName, onOpen, t }) {
      if (subject?.kind !== 'bundle' && subject?.kind !== 'row') return null;
      if (subject.pkg?.name !== packageName) return null;
      if (subject.kind === 'row' && subject.row?.moduleName !== packageName) return null;
      return h(Button, { variant: 'outline', size: 'sm', onClick: onOpen }, t('openConfig'));
    }

    function PluginPage({ renderPanel, onBack, t }) {
      return h('div', { className: 'dsr-page' },
        h('div', { className: 'dsr-backRow' },
          h(Button, { variant: 'ghost', size: 'sm', icon: h('span', { 'aria-hidden': true }, '‹'), onClick: onBack }, t('back'))),
        renderPanel());
    }

    function installPluginPage(ctx, parts) {
      if (typeof ctx.inject !== 'function') {
        registerSettingsFallback(ctx, parts);
        return;
      }
      ctx.inject(['layout', 'pluginNavigation'], (pageCtx) => pageCtx.slots.inject('main', () => {
        try {
        const localeRegistered = parts.localeRegistered === true;
        const unregisterPage = pageCtx.slots.register({
          name: 'main',
          key: PANEL_ID,
          ...(localeRegistered ? { locale: NS } : {}),
          inject: () => ({
            renderPanel: parts.renderPanel,
            onBack: () => pageCtx.pluginNavigation.openBundle(parts.packageName),
            t: parts.t,
          }),
        }, PluginPage);
        const stopActions = pageCtx.slots.inject('plugins.detail.actions', () => pageCtx.slots.register({
          name: 'plugins.detail.actions',
          id: 'dsh-subagent-remote-open',
          order: 20,
          ...(localeRegistered ? { locale: NS } : {}),
          inject: () => ({
            packageName: parts.packageName,
            t: parts.t,
            onOpen: () => pageCtx.layout.selectPanel(PANEL_ID),
          }),
        }, OpenConfigAction));
        return () => {
          stopActions();
          unregisterPage();
        };
        } catch (error) {
          if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('[dsh-subagent-remote] plugin-page registration failed; falling back to Settings:', error);
          registerSettingsFallback(ctx, parts);
          return () => {};
        }
      }));
    }

    /** Last-resort surface: a Settings section, used when plugin-page slots are gone. */
    function registerSettingsFallback(ctx, parts) {
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: PANEL_ID,
          order: 22,
          label: () => parts.t('title'),
          inject: () => ({ connection: ctx.connection, t: parts.t }),
        }, SettingsSection));
        return true;
      } catch {
        return false;
      }
    }

    const plugin = {
      name: 'dsh-subagent-remote-settings',
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        let t = (key) => (Object.hasOwn(zh, key) ? zh[key] : key);
        let localeRegisteredFlag = false;
        const locale = ctx.locale;
        if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          try {
            const registerLocale = () => locale.register(NS, { zh, en });
            if (typeof ctx.effect === 'function') ctx.effect(registerLocale, 'dsh-subagent-remote: dictionaries');
            else registerLocale();
            t = locale.bind(NS);
            localeRegisteredFlag = true;
          } catch {
            // Keep the built-in Chinese fallback when the locale service changes.
          }
        }
        installPluginPage(ctx, {
          packageName: PACKAGE_NAME,
          t,
          localeRegistered: localeRegisteredFlag,
          renderPanel: () => h(SettingsSection, { connection: ctx.connection, t }),
        });
      },
    };

    module.exports = plugin;
    return module.exports;
  },
});
