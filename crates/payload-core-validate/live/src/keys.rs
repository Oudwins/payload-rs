//! Every string the natives use as a property key or pass as a value (`t` keys, literals).
//!
//! Node-API cannot reference strings (this addon's module API version is 8), and creating an
//! internalized key costs about as much as the property read itself. So each native declares the
//! strings of its common path (lib.rs `natives!`); the generated shell (lib.rs `shell_source`)
//! passes them as string literals right after the tag words, and [`crate::Cx::k`] finds them in
//! the current call's frame. Any other string is created on use.

macro_rules! keys {
  ($($name:ident = $text:literal,)*) => {
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    #[repr(u8)]
    pub enum K {
      $($name,)*
    }

    pub const NAMES: &[&str] = &[$($text,)*];
  };
}

keys! {
  // property keys
  DefaultMaxTextLength = "defaultMaxTextLength",
  Length = "length",
  Config = "config",
  Auth = "auth",
  LoginWithUsername = "loginWithUsername",
  RequireUsername = "requireUsername",
  RequireEmail = "requireEmail",
  Username = "username",
  Email = "email",
  Password = "password",
  ToString = "toString",
  Value = "value",
  Label = "label",
  MaxLength = "maxLength",
  MinLength = "minLength",
  StringValue = "stringValue",
  Count = "count",
  Max = "max",
  Min = "min",
  Editor = "editor",
  Validate = "validate",
  BlockType = "blockType",
  AllBlockSlugs = "allBlockSlugs",
  AllowedBlockSlugs = "allowedBlockSlugs",
  InvalidBlockSlugs = "invalidBlockSlugs",
  Join = "join",
  Blocks = "blocks",
  Collections = "collections",
  CustomIDType = "customIDType",
  Db = "db",
  DefaultIDType = "defaultIDType",
  RelationTo = "relationTo",
  Id = "id",
  In = "in",
  And = "and",
  Collection = "collection",
  Depth = "depth",
  DisableErrors = "disableErrors",
  Limit = "limit",
  OverrideAccess = "overrideAccess",
  Pagination = "pagination",
  Req = "req",
  Where = "where",
  Docs = "docs",
  SomeKey = "some",
  ForEach = "forEach",
  Filter = "filter",
  Map = "map",
  Find = "find",
  Includes = "includes",
  IndexOf = "indexOf",
  Push = "push",
  Next = "next",
  Done = "done",
  Return = "return",
  // fields of the shell's `box` (slow paths of the iteration / species helpers)
  BoxA = "a",
  BoxM = "m",
  BoxN = "n",
  BoxR = "r",
  // `t` keys and other literals
  Required = "validation:required",
  ShorterThanMax = "validation:shorterThanMax",
  LongerThanMin = "validation:longerThanMin",
  GeneralValue = "general:value",
  PasswordsDoNotMatch = "fields:passwordsDoNotMatch",
  EmailAddress = "validation:emailAddress",
  InvalidInput = "validation:invalidInput",
  TrueOrFalse = "validation:trueOrFalse",
  TimezoneRequired = "validation:timezoneRequired",
  NotValidDate = "validation:notValidDate",
  GeneralRows = "general:rows",
  GeneralRow = "general:row",
  RequiresAtLeast = "validation:requiresAtLeast",
  RequiresNoMoreThan = "validation:requiresNoMoreThan",
  EnterNumber = "validation:enterNumber",
  GreaterThanMax = "validation:greaterThanMax",
  LessThanMin = "validation:lessThanMin",
  InvalidBlocks = "validation:invalidBlocks",
  InvalidSelection = "validation:invalidSelection",
  RequiresTwoNumbers = "validation:requiresTwoNumbers",
  LongitudeOutOfBounds = "validation:longitudeOutOfBounds",
  LatitudeOutOfBounds = "validation:latitudeOutOfBounds",
  CommaSpace = ", ",
  Text = "text",
}

pub const KEY_COUNT: usize = NAMES.len();

/// The strings one native receives from the shell, in argument order, and the position of each
/// [`K`] among them (`u8::MAX`: not passed).
pub struct KeyList {
  pub keys: &'static [K],
  pub map: [u8; KEY_COUNT],
}

impl KeyList {
  pub const fn new(keys: &'static [K]) -> KeyList {
    let mut map = [u8::MAX; KEY_COUNT];
    let mut i = 0;
    while i < keys.len() {
      map[keys[i] as usize] = i as u8;
      i += 1;
    }
    KeyList { keys, map }
  }
}
