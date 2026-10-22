# OpenMuse with OpenBot

Vocabulary for people, conversations, and reviewed work in OpenMuse's OpenBot integration.

## Language

**Bot**:
A persistent OpenBot coworker that a person can access and converse with. Its permitted capabilities are separate from its description.
_Avoid_: Agent, assistant (when referring to an OpenBot Bot)

**Channel**:
An OpenBot conversation involving a person and a Bot. A channel has its own identity, distinct from the Bot and its conversation thread.
_Avoid_: Thread, chat session

**Thread**:
The durable conversation history associated with a channel.
_Avoid_: Channel

**Reviewed action**:
A proposal for a specific external change whose shown details require a person's recorded approval before execution.
_Avoid_: General tool permission

**Policy approval**:
An OpenBot request for a person's decision about an action governed by the Bot's permissions.
_Avoid_: Reviewed action
