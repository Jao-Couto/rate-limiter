import zookeeper from 'node-zookeeper-client';
import type { Config, Rule } from './config.js';
import type { Logger } from './redis.js';

interface RuleMatch {
  path?: string;
  method?: string;
}

interface RawRule {
  id?: string;
  match?: RuleMatch;
  capacity?: number;
  refillPerSec?: number;
  cost?: number;
}

interface RuleDefaults {
  capacity: number;
  refillPerSec: number;
}

interface RuleSet {
  version: number;
  source: 'env-default' | 'zookeeper';
  default: RuleDefaults;
  rules: RawRule[];
}

export interface RuleSnapshot extends RuleSet {
  zookeeperState: string;
}

export class RuleStore {
  private readonly logger: Logger;
  private readonly path: string;
  private readonly client: zookeeper.Client;
  private ruleSet: RuleSet;

  constructor(config: Config, logger: Logger) {
    this.logger = logger;
    this.path = config.zkRulesPath;
    this.ruleSet = {
      version: 0,
      source: 'env-default',
      default: config.defaultRule,
      rules: [],
    };
    this.client = zookeeper.createClient(config.zookeeperConnect, {
      sessionTimeout: 10000,
      retries: 5,
    });
  }

  get snapshot(): RuleSnapshot {
    return { ...this.ruleSet, zookeeperState: this.client.getState().name };
  }

  start(): void {
    this.client.on('connected', () => {
      this.logger.info({}, 'zookeeper connected');
      this.load();
    });
    this.client.on('disconnected', () => {
      this.logger.warn({}, 'zookeeper disconnected -- serving last known rules');
    });
    this.client.on('expired', () => {
      this.logger.warn({}, 'zookeeper session expired -- reconnecting');
      this.client.connect();
    });
    this.client.connect();
  }

  private load(): void {
    this.client.getData(
      this.path,
      (event) => {
        this.logger.info({ event: event.getName() }, 'rule znode changed');
        this.load();
      },
      (err, data) => {
        if (err || !data) {
          this.logger.warn(
            { err: err?.message ?? 'no data', path: this.path },
            'rule load failed -- keeping current rules',
          );
          return;
        }
        try {
          const parsed = JSON.parse(data.toString('utf8')) as Partial<RuleSet>;
          this.ruleSet = {
            version: parsed.version ?? 0,
            source: 'zookeeper',
            default: parsed.default ?? this.ruleSet.default,
            rules: Array.isArray(parsed.rules) ? parsed.rules : [],
          };
          this.logger.info(
            { version: this.ruleSet.version, rules: this.ruleSet.rules.length },
            'rules updated',
          );
        } catch (parseErr) {
          this.logger.error(
            { err: (parseErr as Error).message },
            'rule znode is not valid JSON -- ignored',
          );
        }
      },
    );
  }

  resolve(request: { path: string; method: string }): Rule {
    for (const rule of this.ruleSet.rules) {
      const match = rule.match ?? {};
      if (match.method && match.method.toUpperCase() !== request.method) continue;
      if (match.path && !pathMatches(match.path, request.path)) continue;
      return {
        id: ruleId(rule, match),
        capacity: rule.capacity ?? this.ruleSet.default.capacity,
        refillPerSec: rule.refillPerSec ?? this.ruleSet.default.refillPerSec,
        cost: rule.cost ?? 1,
      };
    }
    return {
      id: 'default',
      capacity: this.ruleSet.default.capacity,
      refillPerSec: this.ruleSet.default.refillPerSec,
      cost: 1,
    };
  }

  close(): void {
    this.client.close();
  }
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return pattern === path;
}

function ruleId(rule: RawRule, match: RuleMatch): string {
  if (rule.id) return String(rule.id);
  const raw = `${match.method ?? 'any'}:${match.path ?? 'any'}`;
  return raw.replace(/[^a-zA-Z0-9:._-]/g, '_');
}
