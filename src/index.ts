import requestJemaAccess from "@/jema";
import logger from "@/logger";
import env from "env-var";
import fs from "fs/promises";
import mqtt from "mqtt";

type Config = {
  deviceId: string;
  entities: Entity[];
};

type Entity = {
  id: string;
  name: string;
  domain: EntityDomain;
  controlGpio: number;
  monitorGpio: number;
};

type EntityDomain = "lock" | "switch" | "cover";

const TopicType = {
  COMMAND: "set",
  STATE: "state",
  AVAILABILITY: "availability",
} as const;
type TopicType = (typeof TopicType)[keyof typeof TopicType];

const StatusMessage = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
} as const;
type StatusMessage = (typeof StatusMessage)[keyof typeof StatusMessage];

function getTopic(device: Entity, type: TopicType): string {
  return `jema2mqtt/${device.id}/${type}`;
}

async function main() {
  logger.info("jema2mqtt: start");

  const haDiscoveryPrefix = env
    .get("HA_DISCOVERY_PREFIX")
    .default("homeassistant")
    .asString();

  const qos = env.get("QOS").default(1).asIntPositive();

  const { deviceId, entities } = JSON.parse(
    await fs.readFile("./config.json", "utf-8"),
  ) as Config;

  const getDiscoveryMessage = (entity: Entity) => {
    const baseMessage = {
      unique_id: `jema2mqtt_${deviceId}_${entity.id}`,
      name: entity.name,
      command_topic: getTopic(entity, TopicType.COMMAND),
      state_topic: getTopic(entity, TopicType.STATE),
      availability_topic: getTopic(entity, TopicType.AVAILABILITY),
      optimistic: false,
      qos,
      retain: true,
      device: {
        identifiers: [`jema2mqtt_${deviceId}`],
        name: `jema2mqtt.${deviceId}`,
        model: `jema2mqtt`,
        manufacturer: "nana4rider",
      },
      origin: {
        name: "jema2mqtt",
        sw_version: "1.0.0",
        support_url: "https://github.com/nana4rider/jema2mqtt",
      },
    };
    const { domain } = entity;

    if (domain === "lock") {
      return {
        ...baseMessage,
        payload_lock: StatusMessage.ACTIVE,
        payload_unlock: StatusMessage.INACTIVE,
        state_locked: StatusMessage.ACTIVE,
        state_unlocked: StatusMessage.INACTIVE,
      };
    } else if (domain === "switch") {
      return {
        ...baseMessage,
        payload_on: StatusMessage.ACTIVE,
        payload_off: StatusMessage.INACTIVE,
        state_on: StatusMessage.ACTIVE,
        state_off: StatusMessage.INACTIVE,
      };
    } else if (domain === "cover") {
      return {
        ...baseMessage,
        payload_close: StatusMessage.ACTIVE,
        payload_open: StatusMessage.INACTIVE,
        state_closed: StatusMessage.ACTIVE,
        state_open: StatusMessage.INACTIVE,
      };
    }

    throw new Error(`unknown domain: ${entity.domain}`);
  };

  const jemas = new Map(
    await Promise.all(
      entities.map(async ({ id: uniqueId, controlGpio, monitorGpio }) => {
        const jema = await requestJemaAccess(controlGpio, monitorGpio);
        return [uniqueId, jema] as const;
      }),
    ),
  );

  const client = await mqtt.connectAsync(
    env.get("MQTT_BROKER").required().asString(),
    {
      username: env.get("MQTT_USERNAME").asString(),
      password: env.get("MQTT_PASSWORD").asString(),
    },
  );

  logger.info("mqtt-client: connected");

  await client.subscribeAsync(
    entities.map((entity) => {
      const topic = getTopic(entity, TopicType.COMMAND);
      logger.debug(`subscribe: ${topic}`);
      return topic;
    }),
  );

  // 受信して状態を変更
  const handleMessage = async (topic: string, message: string) => {
    const entity = entities.find(
      (entity) => getTopic(entity, TopicType.COMMAND) === topic,
    );
    if (!entity) return;
    const jema = jemas.get(entity.id)!;

    const monitor = await jema.getMonitor();
    if (
      (message === StatusMessage.ACTIVE && !monitor) ||
      (message === StatusMessage.INACTIVE && monitor)
    ) {
      await jema.sendControl();
    }
  };
  client.on("message", (topic, payload) => {
    void handleMessage(topic, payload.toString());
  });

  await Promise.all(
    entities.map(async (entity) => {
      const publishState = (value: boolean) =>
        client.publishAsync(
          getTopic(entity, TopicType.STATE),
          value ? StatusMessage.ACTIVE : StatusMessage.INACTIVE,
          { retain: true },
        );
      const jema = jemas.get(entity.id)!;
      // 状態の変更を検知して送信
      jema.setMonitorListener((value) => void publishState(value));
      // 起動時に送信
      await publishState(await jema.getMonitor());
      // Home Assistantでデバイスを検出
      const discoveryMessage = getDiscoveryMessage(entity);
      await client.publishAsync(
        `${haDiscoveryPrefix}/${entity.domain}/${discoveryMessage.unique_id}/config`,
        JSON.stringify(discoveryMessage),
        { retain: true },
      );
    }),
  );

  const publishAvailability = (value: string) =>
    Promise.all(
      entities.map((entity) =>
        client.publishAsync(getTopic(entity, TopicType.AVAILABILITY), value),
      ),
    );

  // オンライン状態を定期的に送信
  const availabilityTimerId = setInterval(
    () => void publishAvailability("online"),
    env.get("AVAILABILITY_INTERVAL").default(10000).asIntPositive(),
  );

  const shutdownHandler = async () => {
    logger.info("jema2mqtt: shutdown");
    clearInterval(availabilityTimerId);
    await publishAvailability("offline");
    await client.endAsync();
    logger.info("mqtt-client: closed");
    await Promise.all(Array.from(jemas.values()));
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdownHandler());
  process.on("SIGTERM", () => void shutdownHandler());

  await publishAvailability("online");

  logger.info("jema2mqtt: ready");
}

try {
  await main();
} catch (err) {
  logger.error("jema2mqtt:", err);
  process.exit(1);
}
